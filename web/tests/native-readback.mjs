import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectExport } from '../src/issue-model.ts';

export function nativeEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BEADS_|BD_|DOLT_)/.test(key)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'b9s fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'b9s fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...extra };
}

// Only disposable local remotes are accepted; this helper must never publish to GitHub.
export function synchronize({ remote, bd, work, command }) {
  if (!remote.startsWith('/') || !remote.endsWith('.git')) throw Error('Native test readback requires an absolute local bare Git repository');
  work = resolve(work);
  mkdirSync(work);
  mkdirSync(`${work}/home`);
  const env = nativeEnv({ HOME: `${work}/home`, XDG_CONFIG_HOME: `${work}/config`, BEADS_DIR: `${work}/native/.beads` });
  const run = (bin, args, cwd = work) => execFileSync(bin, args, {
    cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const revision = run('git', [`--git-dir=${remote}`, 'rev-parse', 'refs/dolt/data']);
  if (command && command.base !== revision) throw Error('Native test source changed');
  run('git', ['init', 'native']);
  mkdirSync(`${work}/native/.beads`);
  writeFileSync(`${work}/native/.beads/metadata.json`, JSON.stringify({ database: 'dolt', backend: 'dolt', dolt_mode: 'embedded' }));
  writeFileSync(`${work}/native/.beads/config.yaml`, `sync.remote: "git+file://${remote}"\nbackup:\n  enabled: false\n`);
  const native = (...args) => run(resolve(bd), ['--actor=Native test', ...args], `${work}/native`);
  native('bootstrap', '--yes');
  native('dolt', 'pull');
  if (command) {
    if (command.op === 'comment') native('comments', 'add', command.ids[0], '--', command.text);
    else if (command.op === 'update' && Object.keys(command.fields).every(key => key === 'title')) {
      native('update', command.ids[0], `--title=${command.fields.title}`);
    } else throw Error('Unsupported native test command');
    native('dolt', 'push');
  }
  return {
    revision: run('git', [`--git-dir=${remote}`, 'rev-parse', 'refs/dolt/data']),
    snapshot: { issues: projectExport(native('export')) },
  };
}
