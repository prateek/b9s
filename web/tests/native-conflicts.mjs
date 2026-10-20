import assert from 'node:assert/strict';

export async function exerciseNativeConflicts(page, branch = 'main') {
  const result = await page.evaluate(async branch => {
    const { openNativeRuntime } = await import('./native-client.mjs');
    const source = (await (await fetch('./native-fixture.json')).json()).map(({ key, bytes }) => ({
      key, bytes: Uint8Array.from(atob(bytes), char => char.charCodeAt(0)),
    }));
    const identity = { name: 'Conflict tester', email: 'conflict@example.invalid' };
    let local = await openNativeRuntime(`conflict-local-${branch}`, source, branch);
    const remote = await openNativeRuntime(`conflict-remote-${branch}`, source, branch);
    try {
      for (const [client, side] of [[local, 'Local'], [remote, 'Remote']]) {
        const issue = (await client.request({ op: 'issue', id: 'browser-b' }))[0];
        await client.request({ op: 'write', command: {
          op: 'update', key: `conflict-${side}-title`, ids: ['browser-b'],
          expected: { 'browser-b': issue.revision }, fields: { title: `${side} title` },
          actor: identity.name, email: identity.email,
        } });
        const edited = (await client.request({ op: 'issue', id: 'browser-b' }))[0];
        await client.request({ op: 'write', command: {
          op: 'comment', key: `conflict-${side}-comment`, ids: ['browser-b'],
          expected: { 'browser-b': edited.revision }, text: `${side} independent comment`,
          actor: identity.name, email: identity.email,
        } });
      }
      const incoming = await remote.preparePush(source);
      const expectedNativeRevision = (await remote.request({ op: 'issue', id: 'browser-b' }))[0].native_revision;
      const before = await local.request({ op: 'export' });
      const originalLocal = await local.preparePush(source);
      const head = originalLocal.head;
      const preview = await local.previewMerge(incoming.entries, identity);
      const after = await local.request({ op: 'export' });
      const retainedHead = (await local.preparePush(source)).head;
      const resolution = {
        key: 'resolve-native-conflict', ours: preview.ours, theirs: preview.theirs,
        choices: preview.tables.flatMap(table => table.rows.map(row => ({
          table: table.name, id: row.dolt_conflict_id, side: 'theirs',
        }))),
      };
      let incomplete = '', stale = '';
      try { await local.resolveMerge(incoming.entries, identity, { ...resolution, choices: [] }); }
      catch (error) { incomplete = error.message; }
      try { await local.resolveMerge(incoming.entries, identity, { ...resolution, ours: '0'.repeat(32) }); }
      catch (error) { stale = error.message; }
      const afterFailures = await local.request({ op: 'export' });
      const absentReceipt = await local.resolutionReceipt(identity, resolution);
      const applied = await local.resolveMerge(incoming.entries, identity, resolution);
      const recordedReceipt = await local.resolutionReceipt(identity, resolution);
      const resolved = (await local.request({ op: 'issue', id: 'browser-b' }))[0];
      const published = await local.preparePush(incoming.entries);
      const replay = await local.resolveMerge(incoming.entries, identity, resolution);
      const replayHead = (await local.preparePush(incoming.entries)).head;
      let reused = '';
      try { await local.resolveMerge(incoming.entries, identity, { ...resolution, choices: resolution.choices.map(choice => ({ ...choice, side: 'ours' })) }); }
      catch (error) { reused = error.message; }
      local.close();
      local = await openNativeRuntime(`conflict-local-${branch}`, undefined, branch);
      const reopenedReplay = await local.resolveMerge(incoming.entries, identity, resolution);
      const reopenedHead = (await local.preparePush(incoming.entries)).head;
      const keepLocal = await openNativeRuntime(`conflict-keep-local-${branch}`, originalLocal.entries, branch);
      let localTitle;
      try {
        await keepLocal.resolveMerge(incoming.entries, identity, {
          ...resolution, key: 'resolve-keep-local',
          choices: resolution.choices.map(choice => ({ ...choice, side: 'ours' })),
        });
        localTitle = (await keepLocal.request({ op: 'issue', id: 'browser-b' }))[0].title;
      } finally { keepLocal.close(); }
      return {
        preview, unchanged: JSON.stringify(before) === JSON.stringify(after), head, retainedHead,
        incomplete, stale, rejectedUnchanged: JSON.stringify(before) === JSON.stringify(afterFailures),
        applied, replay, reused, resolvedTitle: resolved.title, comments: resolved.comments.map(comment => comment.text),
        resolvedNativeRevision: resolved.native_revision, expectedNativeRevision,
        resolvedHead: published.head, replayHead, reopenedReplay, reopenedHead, localTitle, absentReceipt, recordedReceipt,
      };
    } finally { local.close(); remote.close(); }
  }, branch);
  assert.equal(result.unchanged, true);
  assert.equal(result.head, result.retainedHead);
  assert.equal(result.preview.ours, result.head);
  const issues = result.preview.tables.find(table => table.name === 'issues');
  assert.ok(issues);
  assert.equal(issues.schemaConflicts, 0);
  assert.equal(issues.dataConflicts, 1);
  assert.equal(issues.rows[0].base_title, 'Native browser task');
  assert.equal(issues.rows[0].our_title, 'Local title');
  assert.equal(issues.rows[0].their_title, 'Remote title');
  assert.equal(typeof issues.rows[0].our_row_lock, 'string');
  assert.match(result.incomplete, /every conflict/);
  assert.match(result.stale, /changed|outdated/);
  assert.equal(result.rejectedUnchanged, true);
  assert.equal(result.resolvedTitle, 'Remote title');
  assert.equal(result.resolvedNativeRevision, result.expectedNativeRevision);
  assert.ok(result.comments.includes('Local independent comment'));
  assert.ok(result.comments.includes('Remote independent comment'));
  assert.deepEqual(result.applied, result.replay);
  assert.equal(result.resolvedHead, result.replayHead);
  assert.deepEqual(result.applied, result.reopenedReplay);
  assert.equal(result.resolvedHead, result.reopenedHead);
  assert.equal(result.localTitle, 'Local title');
  assert.equal(result.absentReceipt.state, 'absent');
  assert.equal(result.recordedReceipt.state, 'recorded');
  assert.match(result.reused, /different/);
  return result;
}
