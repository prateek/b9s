import assert from 'node:assert/strict';

export async function exerciseNativeBranches(page) {
  const guards = await page.evaluate(async () => {
    const { openNativeRuntime } = await import('./native-client.mjs');
    const entries = (await (await fetch('./native-fixture.json')).json()).map(({ key, bytes }) => ({
      key, bytes: Uint8Array.from(atob(bytes), character => character.charCodeAt(0)),
    }));
    const client = await openNativeRuntime('branch-guard', entries);
    const rejected = {};
    try {
      for (const op of ['prepare-push', 'preview-merge', 'merge-remote', 'resolve-merge', 'resolution-receipt']) {
        try { await client.request({ op, branch: 'browser-review' }); }
        catch (error) { rejected[op] = error.message; }
      }
      return rejected;
    } finally { client.close(); }
  });
  for (const [op, error] of Object.entries(guards)) assert.match(error, /configured branch/, op);
  assert.equal(Object.keys(guards).length, 5);
  const result = await page.evaluate(async () => {
    const { openNativeRuntime } = await import('./native-client.mjs');
    const entries = (await (await fetch('./native-fixture.json')).json()).map(({ key, bytes }) => ({
      key, bytes: Uint8Array.from(atob(bytes), character => character.charCodeAt(0)),
    }));
    const identity = { name: 'Branch tester', email: 'branch@example.invalid' };
    const branch = 'browser-review';
    const client = await openNativeRuntime('branch-review', entries, branch);
    const remote = await openNativeRuntime('branch-remote', entries, branch);
    const rejected = {};
    try {
      const before = await client.request({ op: 'export' });
      const explicitHead = (await client.preparePush(entries, branch)).head;
      const defaultHead = (await client.preparePush(entries)).head;
      for (const op of ['prepare-push', 'preview-merge', 'merge-remote', 'resolve-merge', 'resolution-receipt']) {
        try { await client.request({ op, branch: 'main', identity }); }
        catch (error) { rejected[op] = error.message; }
      }
      const unchanged = JSON.stringify(before) === JSON.stringify(await client.request({ op: 'export' }));
      for (const [runtime, id, title] of [
        [client, 'browser-b', 'Review branch task'],
        [remote, 'browser-a', 'Review branch epic'],
      ]) {
        const issue = (await runtime.request({ op: 'issue', id }))[0];
        await runtime.request({ op: 'write', command: {
          key: `branch-${id}`, op: 'update', ids: [id], expected: { [id]: issue.revision },
          fields: { title }, actor: identity.name, email: identity.email,
        } });
      }
      const incoming = await remote.preparePush(entries);
      const preview = await client.previewMerge(incoming.entries, identity);
      await client.mergeRemote(incoming.entries, identity);
      const published = await client.preparePush(incoming.entries);
      const main = await openNativeRuntime('branch-main-readback', published.entries, 'main');
      const review = await openNativeRuntime('branch-review-readback', published.entries, branch);
      try {
        return {
          rejected, unchanged, explicitHead, defaultHead, preview,
          main: await main.request({ op: 'export' }),
          review: await review.request({ op: 'export' }),
        };
      } finally { main.close(); review.close(); }
    } finally { client.close(); remote.close(); }
  });
  for (const op of ['prepare-push', 'preview-merge', 'merge-remote', 'resolve-merge', 'resolution-receipt']) {
    assert.match(result.rejected[op] || '', /configured branch/, op);
  }
  assert.equal(result.unchanged, true);
  assert.equal(result.defaultHead, result.explicitHead);
  assert.equal(result.main.find(issue => issue.id === 'browser-b').title, 'Native browser task');
  assert.equal(result.main.find(issue => issue.id === 'browser-a').title, 'Native browser epic');
  assert.equal(result.review.find(issue => issue.id === 'browser-b').title, 'Review branch task');
  assert.equal(result.review.find(issue => issue.id === 'browser-a').title, 'Review branch epic');
  return result;
}
