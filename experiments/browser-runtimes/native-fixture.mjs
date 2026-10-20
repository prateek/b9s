import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeEnv } from '../../web/tests/native-readback.mjs';

if (!process.env.B9S_TEST_BD) throw Error('Set B9S_TEST_BD to the native version under test');
const bd = resolve(process.env.B9S_TEST_BD);
const root = mkdtempSync(resolve('.b9s-e2e/browser-runtimes/native-release-'));
mkdirSync(`${root}/home`);
const env = nativeEnv({
  HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, BEADS_DIR: `${root}/source/.beads`,
  BD_DISABLE_METRICS: '1', DO_NOT_TRACK: '1',
});
const run = (bin, args, cwd = root) => execFileSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
run('git', ['init', '--bare', 'remote.git']);
run('git', ['init', '--initial-branch=main', 'source']);
const native = (...args) => run(bd, args, `${root}/source`);
native('init', '--prefix=browser', '--skip-hooks', '--skip-agents', '--non-interactive');
run('git', ['commit', '--allow-empty', '-m', 'Synthetic browser fixture'], `${root}/source`);
run('git', ['push', `${root}/remote.git`, 'HEAD:refs/heads/main'], `${root}/source`);
native('create', '--id=browser-a', '--title=Native browser epic', '--type=epic');
native('create', '--id=browser-b', '--title=Native browser task', '--type=task');
native('comments', 'add', 'browser-b', 'Native release fixture comment');
native('dep', 'add', 'browser-b', 'browser-a');
native('dolt', 'remote', 'add', 'origin', `git+file://${root}/remote.git`);
native('dolt', 'push');
writeFileSync(`${root}/evidence.json`, JSON.stringify({ version: native('version'), export: native('export') }, null, 2));
console.log(`${root}/remote.git`);
