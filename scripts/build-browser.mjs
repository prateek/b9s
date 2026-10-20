import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const series = path => readFileSync(path, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw Error(`Unexpected source symlink: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

function writable(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) writable(path);
    else if (!entry.isSymbolicLink()) chmodSync(path, 0o644);
  }
}

export function prepareBrowserBuild(destination, vendor = `${repository}/third_party/beads/v1.3.1`) {
  const work = resolve(destination);
  vendor = resolve(vendor);
  if (existsSync(work)) throw Error(`Build directory must be new: ${work}`);
  const pin = JSON.parse(readFileSync(`${vendor}/provenance.json`));
  if (hash(readFileSync(`${vendor}/${pin.archive}`)) !== pin.sha256) throw Error('Beads archive checksum mismatch');
  const beadPatches = series(`${vendor}/patches/series`);
  if (JSON.stringify(beadPatches) !== JSON.stringify(pin.patches)) throw Error('Beads patch series differs from provenance');
  const browser = `${repository}/third_party/beads/browser`;
  const dependencies = JSON.parse(readFileSync(`${browser}/dependencies.json`));
  const patches = series(`${browser}/patches/series`);
  if (JSON.stringify(patches) !== JSON.stringify(dependencies.map(dependency => dependency.patch))) throw Error('Dependency patch order mismatch');
  mkdirSync(`${work}/tmp`, { recursive: true });
  mkdirSync(`${work}/beads`);
  const env = { ...process.env, GOTMPDIR: `${work}/tmp`, GOWORK: 'off' };
  const run = (bin, args, cwd = work, extra = {}) => execFileSync(bin, args, {
    cwd, env: { ...env, ...extra }, stdio: 'inherit', timeout: 900000,
  });
  const apply = (directory, patch) => {
    run('git', ['apply', '--check', patch], directory);
    run('git', ['apply', patch], directory);
    run('git', ['apply', '--reverse', '--check', patch], directory);
  };
  run('tar', ['-xzf', `${vendor}/${pin.archive}`, '--strip-components=1', '-C', `${work}/beads`]);
  run('git', ['init', '--quiet'], `${work}/beads`);
  for (const patch of beadPatches) {
    if (!/^[A-Za-z0-9._-]+\.patch$/.test(patch)) throw Error('Invalid Beads patch filename');
    apply(`${work}/beads`, `${vendor}/patches/${patch}`);
  }
  const replacements = [];
  for (const dependency of dependencies) {
    const original = JSON.parse(execFileSync('go', ['mod', 'download', '-json', `${dependency.path}@${dependency.version}`], {
      env, encoding: 'utf8', timeout: 120000,
    }));
    if (original.Sum !== dependency.sum || original.GoModSum !== dependency.goModSum) throw Error(`Module checksum mismatch: ${dependency.path}`);
    const target = `${work}/sources/${dependency.key}`;
    cpSync(original.Dir, target, { recursive: true, errorOnExist: true });
    writable(target);
    run('git', ['init', '--quiet'], target);
    apply(target, `${browser}/patches/${dependency.patch}`);
    replacements.push(`-replace=${dependency.path}=${relative(`${work}/beads`, target)}`);
  }
  cpSync(`${browser}/gozstd`, `${work}/sources/gozstd`, { recursive: true, errorOnExist: true });
  const codecReplacement = '-replace=github.com/dolthub/gozstd=../sources/gozstd';
  const inputFiles = [
    ...files(`${repository}/web/native`), ...files(browser),
    `${vendor}/provenance.json`, `${vendor}/patches/series`, `${vendor}/${pin.archive}`,
    ...beadPatches.map(patch => `${vendor}/patches/${patch}`),
    fileURLToPath(import.meta.url),
  ];
  const inputs = Object.fromEntries(inputFiles.map(path => [relative(repository, path), hash(readFileSync(path))]));
  return { work, pin, dependencies, patches, replacements, codecReplacement, browser, run, env, inputs };
}

export function buildBrowserRuntime(destination) {
  return emitBrowserRuntime(prepareBrowserBuild(destination));
}

export function emitBrowserRuntime(build) {
  const { work, run, replacements, codecReplacement } = build;
  const modfile = `${work}/native.mod`;
  copyFileSync(`${work}/beads/go.mod`, modfile);
  copyFileSync(`${work}/beads/go.sum`, `${work}/native.sum`);
  run('go', ['mod', 'edit', `-modfile=${modfile}`, ...replacements, codecReplacement], `${work}/beads`);
  const command = `${work}/beads/cmd/b9s-browser`;
  mkdirSync(command);
  for (const path of files(`${repository}/web/native`).filter(path => path.endsWith('.go'))) {
    copyFileSync(path, `${command}/${relative(`${repository}/web/native`, path)}`);
  }
  run('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-tags=gms_pure_go', `-modfile=${modfile}`, '-o', `${work}/native.wasm`, './cmd/b9s-browser'], `${work}/beads`, {
    GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0',
  });
  const wasm = readFileSync(`${work}/native.wasm`);
  writeFileSync(`${work}/native.wasm.gz`, gzipSync(wasm, { level: 9 }));
  const toolchain = { cwd: `${work}/beads`, encoding: 'utf8', env: build.env };
  const goroot = execFileSync('go', ['env', 'GOROOT'], toolchain).trim();
  copyFileSync(`${goroot}/lib/wasm/wasm_exec.js`, `${work}/wasm_exec.js`);
  const manifest = {
    schema: 1, kind: 'b9s-native', beads: build.pin, dependencies: build.dependencies,
    patchSeries: build.patches, inputs: build.inputs,
    goVersion: execFileSync('go', ['version'], toolchain).trim(),
    files: Object.fromEntries(['native.wasm.gz', 'wasm_exec.js'].map(name => [name, hash(readFileSync(`${work}/${name}`))])),
    wasm: { sha256: hash(wasm), bytes: wasm.length },
  };
  writeFileSync(`${work}/runtime.json`, JSON.stringify(manifest, null, 2));
  verifyBrowserRuntime(work);
  console.log(`Built pinned browser runtime: ${work}`);
  return manifest;
}

export function verifyBrowserRuntime(directory, sourceRoot = repository) {
  const manifest = JSON.parse(readFileSync(`${directory}/runtime.json`));
  if (manifest.schema !== 1 || manifest.kind !== 'b9s-native') throw Error('A production native runtime is required');
  if (!manifest.inputs || !Object.keys(manifest.inputs).length) throw Error('Runtime source inputs are missing');
  for (const [path, expected] of Object.entries(manifest.inputs)) {
    if (path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || !part)) throw Error('Invalid runtime input path');
    if (hash(readFileSync(`${sourceRoot}/${path}`)) !== expected) throw Error(`Runtime input changed: ${path}`);
  }
  for (const directory of ['web/native', 'third_party/beads/browser']) {
    for (const path of files(`${sourceRoot}/${directory}`)) {
      if (!(relative(sourceRoot, path) in manifest.inputs)) throw Error(`Runtime input was not built: ${path}`);
    }
  }
  for (const name of ['native.wasm.gz', 'wasm_exec.js']) {
    if (hash(readFileSync(`${directory}/${name}`)) !== manifest.files?.[name]) throw Error(`Runtime checksum mismatch: ${name}`);
  }
  const wasm = gunzipSync(readFileSync(`${directory}/native.wasm.gz`));
  if (wasm.length !== manifest.wasm?.bytes || hash(wasm) !== manifest.wasm?.sha256) throw Error('Decompressed runtime checksum mismatch');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBrowserRuntime(process.argv[2] || `${repository}/.b9s-e2e/native-runtime`);
}
