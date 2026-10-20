import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { nativeEnv } from './native-readback.mjs';

const { values, positionals } = parseArgs({ options: { site: { type: 'string' } }, allowPositionals: true });
if (positionals.length !== 1) throw Error('Usage: native-fixture.mjs <new-fixture-directory> [--site <new-static-site-directory>]');
const root = resolve(positionals[0]);
const bd = resolve(process.env.B9S_TEST_BD);
const goCache = JSON.parse(execFileSync('go', ['env', '-json', 'GOCACHE', 'GOMODCACHE'], {
  encoding: 'utf8', timeout: 10000,
}));
mkdirSync(root);
mkdirSync(`${root}/home`);
const seed = `${root}/seed`, remote = `${root}/remote.git`;
const env = nativeEnv({
  HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`,
  BEADS_DIR: `${seed}/.beads`,
  ...goCache, CGO_ENABLED: '1', GOWORK: 'off',
});
const run = (bin, args, cwd = root) => execFileSync(bin, args, {
  cwd, env, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
run('git', ['init', '--bare', remote]);
run('git', ['init', seed]);
const native = (...args) => run(bd, ['--actor=Browser fixture', ...args], seed);
native('init', '--prefix=browser', '--skip-hooks', '--skip-agents');
run('git', ['commit', '--allow-empty', '-m', 'Synthetic browser source'], seed);
run('git', ['push', remote, 'HEAD:refs/heads/main'], seed);
native('create', '--id=browser-a', '--title=Native browser epic', '--type=epic', '--description=Synthetic fixture only.');
native('create', '--id=browser-b', '--title=Native browser task', '--type=task', '--description=Native browser fixture.', '--deps=blocked-by:browser-a');
native('comments', 'add', 'browser-b', 'Native release fixture comment');
native('remember', 'Synthetic native memory survives browser synchronization.', '--key=browser-fixture');
native('dolt', 'remote', 'add', 'origin', `git+file://${remote}`);
native('dolt', 'push');
const source = dirname(bd);
if (!readFileSync(`${source}/go.mod`, 'utf8').includes('module github.com/steveyegge/beads')) {
  throw Error('B9S_TEST_BD must name the CLI built by scripts/build-beads.mjs');
}
const helper = mkdtempSync(`${source}/cmd/b9s-fixture-`);
copyFileSync(new URL('./native-fixture/main.go', import.meta.url), `${helper}/main.go`);
run('go', ['run', '-tags=gms_pure_go', `${helper}/main.go`, `${seed}/.beads/embeddeddolt`], source);
writeFileSync(`${root}/fixture.json`, JSON.stringify({ remote, bd }, null, 2));
if (values.site) {
  const site = resolve(values.site);
  mkdirSync(site);
  const entries = run('git', [`--git-dir=${remote}`, 'ls-tree', '-r', 'refs/dolt/data']).split('\n').map(line => {
    const [metadata, key] = line.split('\t');
    const bytes = execFileSync('git', [`--git-dir=${remote}`, 'cat-file', 'blob', metadata.split(' ')[2]], {
      env, timeout: 30000, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString('base64');
    return { key, bytes };
  });
  writeFileSync(`${site}/native-fixture.json`, JSON.stringify(entries));
  writeFileSync(`${site}/native-config.json`, JSON.stringify({
    schema: 1, projects: [{ key: 'demo', name: 'Synthetic Beads demo', bootstrap: './native-fixture.json' }],
    identity: { name: 'Demo user', email: 'demo@example.invalid' },
  }, null, 2));
}
console.log(remote);
