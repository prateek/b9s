import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareBrowserBuild, emitBrowserRuntime } from '../../scripts/build-browser.mjs';

const repo = resolve('.');
const experiment = resolve('experiments/browser-runtimes');
const vendor = resolve(process.env.B9S_BEADS_VENDOR || 'third_party/beads/v1.3.1');
const build = prepareBrowserBuild(process.argv[2] || '.b9s-e2e/browser-runtime-build', vendor);
const { work, run, pin, dependencies, patches: series, replacements, codecReplacement, browser, inputs } = build;
for (const name of ['lite', 'full', 'persistent']) {
  copyFileSync(`${work}/beads/go.mod`, `${work}/${name}.mod`);
  copyFileSync(`${work}/beads/go.sum`, `${work}/${name}.sum`);
  const flags = name === 'lite' ? replacements.slice(0, 1) : [...replacements, codecReplacement];
  run('go', ['mod', 'edit', `-modfile=${work}/${name}.mod`, ...flags], `${work}/beads`);
  const cmd = `${work}/beads/cmd/browser-${name}-probe`;
  mkdirSync(cmd);
  copyFileSync(`${experiment}/${name}.go`, `${cmd}/main.go`);
  if (name === 'persistent') {
    copyFileSync(`${experiment}/command-driver.go`, `${cmd}/driver.go`);
    for (const file of readdirSync(`${repo}/web/native`).filter(file => file.endsWith('.go') && file !== 'main_js.go')) {
      copyFileSync(`${repo}/web/native/${file}`, `${cmd}/${file}`);
    }
  }
  run('go', ['build', '-tags=gms_pure_go', `-modfile=${work}/${name}.mod`, '-o', `${work}/${name}.wasm`, `./cmd/browser-${name}-probe`], `${work}/beads`, { GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' });
}
emitBrowserRuntime(build);
copyFileSync(`${experiment}/schema.json`, `${work}/schema.json`);
mkdirSync(`${work}/results`);
run('npm', ['install', '--prefix', `${work}/npm`, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', `${repo}/.b9s-e2e/backend-free/npm-cache`, '@dolthub/doltlite-wasm@0.51.1']);
writeFileSync(`${work}/build.json`, JSON.stringify({
  beads: pin.commit, dependencies, patchSeries: series, inputs,
  runtimeSourceHash: createHash('sha256').update(readFileSync(`${repo}/web/native/runtime_js.go`)).digest('hex'),
  writeSourceHash: createHash('sha256').update(readFileSync(`${repo}/web/native/write_js.go`)).digest('hex'),
  syncSourceHash: createHash('sha256').update(readFileSync(`${repo}/web/native/sync_js.go`)).digest('hex'),
  sourceHashes: Object.fromEntries(['lite.go', 'full.go', 'persistent.go', 'command-driver.go'].map(name => [
    name, createHash('sha256').update(readFileSync(`${experiment}/${name}`)).digest('hex'),
  ])),
  patchHashes: Object.fromEntries(series.map(name => [
    name, createHash('sha256').update(readFileSync(`${browser}/patches/${name}`)).digest('hex'),
  ])),
  binaries: Object.fromEntries(['lite', 'full', 'persistent'].map(name => [name, createHash('sha256').update(readFileSync(`${work}/${name}.wasm`)).digest('hex')])),
}, null, 2));
console.log(`Built WASM probes; B9S_RUNTIME_WORK=${work}`);
