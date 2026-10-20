import assert from 'node:assert/strict';

export const faultWorker = `
import './native-worker.mjs';
const receive = self.onmessage;
let failed = false;
self.onmessage = async event => {
  if (['resolve-merge', 'merge-remote'].includes(event.data.op) && !failed) {
    const call = nativeStore.call.bind(nativeStore);
    nativeStore.call = async (op, key, bytes, ...args) => {
      if (op === 'cas' && key === 'manifest' && !failed) {
        const previous = await call('get', key);
        const root = data => new TextDecoder().decode(data).split(':')[3];
        if (root(previous.bytes) !== root(bytes)) {
          failed = true;
          await nativeStore.saveState('injected-failure', { before: root(previous.bytes), after: root(bytes) });
          throw Error('Synthetic manifest persistence failure');
        }
      }
      return call(op, key, bytes, ...args);
    };
  }
  await receive(event);
};
`;

export async function exerciseResolutionEdges(page) {
  const result = await page.evaluate(async () => {
    const { openNativeRuntime } = await import('./native-client.mjs');
    const source = (await (await fetch('./native-fixture.json')).json()).map(({ key, bytes }) => ({
      key, bytes: Uint8Array.from(atob(bytes), character => character.charCodeAt(0)),
    }));
    const identity = { name: 'Resolution tester', email: 'resolution@example.invalid' };
    async function change(client, id, key, fields, op = 'update') {
      const issue = (await client.request({ op: 'issue', id }))[0];
      return client.request({ op: 'write', command: {
        op, key, ids: [id], expected: { [id]: issue.revision },
        ...(fields ? { fields } : {}), actor: identity.name, email: identity.email,
      } });
    }
    function choices(preview, key, side) {
      return {
        key, ours: preview.ours, theirs: preview.theirs,
        choices: preview.tables.flatMap(table => table.rows.map(row => ({
          table: table.name, id: row.dolt_conflict_id,
          side: typeof side === 'function' ? side(row) : side,
        }))),
      };
    }
    const deleted = await openNativeRuntime('resolution-deleted', source);
    const updated = await openNativeRuntime('resolution-updated', source);
    const deletion = [];
    try {
      await change(deleted, 'browser-b', 'resolution-delete', undefined, 'delete');
      await change(updated, 'browser-b', 'resolution-update', { title: 'Updated competing record' });
      const deletedData = await deleted.preparePush(source);
      const updatedData = await updated.preparePush(source);
      for (const [name, local, incoming] of [
        ['local-delete', deletedData.entries, updatedData.entries],
        ['remote-delete', updatedData.entries, deletedData.entries],
      ]) {
        for (const side of ['ours', 'theirs']) {
          const client = await openNativeRuntime(`resolution-${name}-${side}`, local);
          try {
            const preview = await client.previewMerge(incoming, identity);
            await client.resolveMerge(incoming, identity, choices(preview, `${name}-${side}`, side));
            const issues = await client.request({ op: 'export' });
            const published = await client.preparePush(incoming);
            deletion.push({
              name, side, issue: issues.find(issue => issue.id === 'browser-b') || null,
              conflicts: preview.tables.map(table => ({ table: table.name, count: table.dataConflicts })),
              head: published.head,
            });
          } finally { client.close(); }
        }
      }
    } finally { deleted.close(); updated.close(); }

    const local = await openNativeRuntime('resolution-multi-local', source);
    const remote = await openNativeRuntime('resolution-multi-remote', source);
    try {
      for (const [client, side] of [[local, 'Local'], [remote, 'Remote']]) {
        for (const id of ['browser-a', 'browser-b']) {
          await change(client, id, `multi-${side}-${id}`, { title: `${side} ${id}` });
        }
      }
      const original = await local.preparePush(source);
      const incoming = await remote.preparePush(source);
      const preview = await local.previewMerge(incoming.entries, identity);
      const resolution = choices(preview, 'multi-reviewed-resolution', row => row.our_id === 'browser-a' ? 'ours' : 'theirs');
      const OriginalWorker = window.Worker;
      let faulty;
      try {
        window.Worker = class extends OriginalWorker {
          constructor(url, options) { super(new URL('./native-fault-worker.mjs', url), options); }
        };
        faulty = await openNativeRuntime('resolution-fault', original.entries);
      } finally { window.Worker = OriginalWorker; }
      let failure = '', receipt, injected, afterFailure, retainedHead;
      try {
        try { await faulty.resolveMerge(incoming.entries, identity, resolution); }
        catch (error) { failure = error.message; }
        injected = await faulty.state.get('injected-failure');
        receipt = await faulty.resolutionReceipt(identity, resolution);
        afterFailure = await faulty.request({ op: 'export' });
        retainedHead = (await faulty.preparePush(source)).head;
      } finally { faulty.close(); }
      const reopened = await openNativeRuntime('resolution-fault');
      let resolved, retriedHead, replayHead;
      try {
        await reopened.resolveMerge(incoming.entries, identity, resolution);
        resolved = await reopened.request({ op: 'export' });
        retriedHead = (await reopened.preparePush(incoming.entries)).head;
        await reopened.resolveMerge(incoming.entries, identity, resolution);
        replayHead = (await reopened.preparePush(incoming.entries)).head;
      } finally { reopened.close(); }
      return { deletion, failure, receipt, injected, afterFailure, retainedHead, originalHead: original.head, resolved, retriedHead, replayHead };
    } finally { local.close(); remote.close(); }
  });
  for (const { name, side, issue, conflicts } of result.deletion) {
    assert.ok(conflicts.some(conflict => conflict.table === 'issues' && conflict.count === 1));
    const keepDeletion = (name === 'local-delete') === (side === 'ours');
    if (keepDeletion) assert.equal(issue, null, `${name} ${side}`);
    else assert.equal(issue.title, 'Updated competing record', `${name} ${side}`);
  }
  assert.match(result.failure, /committing reviewed merge.*Synthetic manifest persistence failure/);
  assert.notEqual(result.injected.before, result.injected.after);
  assert.equal(result.receipt.state, 'absent');
  assert.equal(result.retainedHead, result.originalHead);
  for (const id of ['browser-a', 'browser-b']) {
    assert.equal(result.afterFailure.find(issue => issue.id === id).title, `Local ${id}`);
  }
  assert.equal(result.resolved.find(issue => issue.id === 'browser-a').title, 'Local browser-a');
  assert.equal(result.resolved.find(issue => issue.id === 'browser-b').title, 'Remote browser-b');
  assert.equal(result.retriedHead, result.replayHead);
  return result;
}
