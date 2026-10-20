import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nativeEnv } from './native-readback.mjs';

export async function exerciseNativeReadiness(page, evidenceRoot, bd) {
  const cases = await page.evaluate(async () => {
    const { openNativeRuntime } = await import('./native-client.mjs');
    const source = (await (await fetch('./native-fixture.json')).json()).map(({ key, bytes }) => ({
      key, bytes: Uint8Array.from(atob(bytes), character => character.charCodeAt(0)),
    }));
    const identity = { name: 'Readiness tester', email: 'readiness@example.invalid' };
    async function write(runtime, op, id, key, fields) {
      const issue = id && (await runtime.request({ op: 'issue', id }))[0];
      return runtime.request({ op: 'write', command: {
        op, key, ids: id ? [id] : [], expected: id ? { [id]: issue.revision } : {},
        ...(fields ? { fields } : {}), actor: identity.name, email: identity.email,
      } });
    }
    const encode = entries => entries.map(({ key, bytes }) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return { key, bytes: btoa(binary) };
    });
    const results = [];
    for (const scenario of ['clean', 'resolved', 'fast-forward']) {
      const local = await openNativeRuntime(`readiness-${scenario}-local`, source);
      const remote = await openNativeRuntime(`readiness-${scenario}-remote`, source);
      try {
        let expectedID = 'browser-b';
        if (scenario === 'clean') {
          const created = await write(local, 'create', null, 'readiness-child', { title: 'Child inherits parent blocker', parent: 'browser-b' });
          expectedID = created.created;
          await write(remote, 'close', 'browser-a', 'readiness-close');
        } else if (scenario === 'fast-forward') {
          await write(remote, 'close', 'browser-a', 'readiness-fast-forward');
        } else {
          await write(local, 'delete', 'browser-b', 'readiness-delete');
          await write(remote, 'update', 'browser-b', 'readiness-update', { title: 'Restored without deleted dependency' });
        }
        const before = await local.preparePush(source);
        const incoming = await remote.preparePush(source);
        const preview = await local.previewMerge(incoming.entries, identity);
        let recovery;
        if (scenario !== 'resolved') {
          if (preview.tables.length) throw Error('Expected an independent native merge');
          if (scenario === 'clean') {
            const OriginalWorker = window.Worker;
            let faulty;
            try {
              window.Worker = class extends OriginalWorker {
                constructor(url, options) { super(new URL('./native-fault-worker.mjs', url), options); }
              };
              faulty = await openNativeRuntime('readiness-fault', before.entries);
            } finally { window.Worker = OriginalWorker; }
            let failure = '', retainedHead;
            try {
              try { await faulty.mergeRemote(incoming.entries, identity); }
              catch (error) { failure = error.message; }
              retainedHead = (await faulty.preparePush(source)).head;
            } finally { faulty.close(); }
            const reopened = await openNativeRuntime('readiness-fault');
            try {
              await reopened.mergeRemote(incoming.entries, identity);
              const retried = await reopened.preparePush(incoming.entries);
              await reopened.mergeRemote(incoming.entries, identity);
              const replayHead = (await reopened.preparePush(incoming.entries)).head;
              recovery = {
                failure, retainedHead, originalHead: before.head,
                retriedHead: retried.head, replayHead, entries: encode(retried.entries),
              };
            } finally { reopened.close(); }
          }
          await local.mergeRemote(incoming.entries, identity);
        } else {
          await local.resolveMerge(incoming.entries, identity, {
            key: 'readiness-resolution', ours: preview.ours, theirs: preview.theirs,
            choices: preview.tables.flatMap(table => table.rows.map(row => ({
              table: table.name, id: row.dolt_conflict_id, side: 'theirs',
            }))),
          });
        }
        const after = await local.preparePush(incoming.entries);
        let replayHead = after.head;
        if (scenario !== 'resolved') {
          await local.mergeRemote(incoming.entries, identity);
          replayHead = (await local.preparePush(incoming.entries)).head;
        }
        results.push({ scenario, expectedID, before: encode(before.entries), incoming: encode(incoming.entries), after: encode(after.entries), head: after.head, replayHead, recovery });
      } finally { local.close(); remote.close(); }
    }
    return results;
  });
  const source = dirname(resolve(bd));
  const helper = mkdtempSync(`${source}/cmd/b9s-readiness-`);
  copyFileSync(new URL('./native-fixture/main.go', import.meta.url), `${helper}/main.go`);
  const goCache = JSON.parse(execFileSync('go', ['env', '-json', 'GOCACHE', 'GOMODCACHE'], { encoding: 'utf8', timeout: 10000 }));
  const root = mkdtempSync(`${evidenceRoot}/readiness-native-`);
  mkdirSync(`${root}/home`);
  const env = nativeEnv({ ...goCache, CGO_ENABLED: '1', GOWORK: 'off', HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, BEADS_DIR: `${root}/unused` });
  function inspect(entries, name) {
    const directory = `${root}/${name}`;
    const dolt = `${directory}/browser/.dolt`;
    mkdirSync(`${dolt}/noms`, { recursive: true });
    mkdirSync(`${dolt}/temptf`);
    writeFileSync(`${dolt}/config.json`, '{}');
    writeFileSync(`${dolt}/repo_state.json`, JSON.stringify({ head: 'refs/heads/main', remotes: {}, branches: {} }));
    for (const { key, bytes } of entries) {
      if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw Error(`Unexpected native blob key: ${key}`);
      writeFileSync(`${dolt}/noms/${key}`, Buffer.from(bytes, 'base64'));
    }
    return JSON.parse(execFileSync('go', ['run', '-tags=gms_pure_go', `${helper}/main.go`, directory, 'inspect'], {
      cwd: source, env, encoding: 'utf8', timeout: 120000,
    }));
  }
  const result = cases.map(({ scenario, expectedID, before, incoming, after, head, replayHead, recovery }) => ({
    scenario, expectedID, head, replayHead,
    before: inspect(before, `${scenario}-before`),
    incoming: inspect(incoming, `${scenario}-incoming`),
    after: inspect(after, `${scenario}-after`),
    recovery: recovery ? { ...recovery, entries: undefined, blocked: inspect(recovery.entries, `${scenario}-recovered`) } : undefined,
  }));
  writeFileSync(`${root}/results.json`, JSON.stringify(result, null, 2));
  assert.equal(result[0].before[result[0].expectedID], true, 'local child must initially inherit a blocker');
  assert.equal(result[1].incoming['browser-b'], true, 'competing update must initially be blocked');
  for (const item of result) assert.equal(item.after[item.expectedID], false, `${item.scenario}: persisted native readiness must follow the merged graph`);
  for (const item of result) assert.equal(item.head, item.replayHead, `${item.scenario}: repeated merge must not create a commit`);
  const recovered = result[0].recovery;
  assert.match(recovered.failure, /committing native merge.*Synthetic manifest persistence failure/);
  assert.equal(recovered.retainedHead, recovered.originalHead);
  assert.equal(recovered.retriedHead, recovered.replayHead);
  assert.equal(recovered.blocked[result[0].expectedID], false);
  return result;
}
