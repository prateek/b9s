import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitRemote, GitConflictError, GitOutcomeUnknownError } from '../src/git-remote.mjs';

const oid = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const bytes = text => new TextEncoder().encode(text);
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), newer = 'c'.repeat(40), prepared = 'd'.repeat(40);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const publication = () => ({ repository: 'fixture/data', ref: 'refs/dolt/data', base: commit, commit: prepared });

test('public reads fetch immutable raw blobs without credentials and verify their Git checksum', async () => {
  for (const corrupt of [false, true]) {
    const data = bytes('manifest');
    let requests = 0;
    const remote = new GitRemote({ repository: 'fixture/data', publicRead: true, token: () => 'must-not-send', fetch: async (url, options) => {
      requests++;
      assert.equal(options.headers?.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      if (url.startsWith('https://api.github.com/')) assert.equal(options.cache, 'no-store');
      if (url.includes('/ref/')) return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: commit } });
      if (url.includes('/commits/')) return response({ sha: commit, tree: { sha: tree } });
      if (url.includes('/trees/')) return response({ sha: tree, tree: [{ path: 'manifest', type: 'blob', mode: '100644', sha: oid(data) }] });
      assert.equal(url, `https://raw.githubusercontent.com/fixture/data/${commit}/manifest`);
      return new Response(corrupt ? bytes('wrong') : data);
    } });
    if (corrupt) await assert.rejects(remote.read(), /checksum/);
    else {
      assert.deepEqual((await remote.read()).entries, [{ key: 'manifest', bytes: data }]);
      const before = requests;
      assert.deepEqual((await remote.read()).entries, [{ key: 'manifest', bytes: data }]);
      assert.equal(requests - before, 1, 'An unchanged head only needs one fresh ref request');
    }
    await assert.rejects(remote.request('git/blobs', 'POST', {}), /read-only/);
  }
});

test('reads native flat and multipart blobs at one immutable Git commit', async () => {
  const blobs = ['manifest', 'part one', 'part two'].map(text => bytes(text));
  const objects = new Map(blobs.map(data => [oid(data), data]));
  const requests = [];
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (url, options) => {
    requests.push({ url, headers: options.headers });
    const path = new URL(url).pathname;
    if (path.endsWith('/git/ref/dolt/data')) return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: commit } });
    if (path.endsWith(`/commits/${commit}`)) return response({ sha: commit, tree: { sha: tree } });
    if (path.endsWith(`/trees/${tree}`)) return response({ sha: tree, tree: [
      { path: 'manifest', type: 'blob', mode: '100644', sha: oid(blobs[0]) },
      { path: 'tablefile', type: 'tree', mode: '040000', sha: newer },
    ] });
    if (path.endsWith(`/trees/${newer}`)) return response({ sha: newer, tree: blobs.slice(1).map((data, i) => ({
      path: String(i + 1).padStart(4, '0'), type: 'blob', mode: '100644', sha: oid(data),
    })) });
    const data = objects.get(path.split('/').at(-1));
    assert.ok(data);
    return response({ encoding: 'base64', content: Buffer.from(data).toString('base64'), size: data.length });
  } });
  const result = await remote.read();
  assert.equal(result.commit, commit);
  assert.deepEqual(result.entries.map(({ key, bytes }) => [key, new TextDecoder().decode(bytes)]), [
    ['manifest', 'manifest'], ['tablefile', 'part onepart two'],
  ]);
  assert.ok(requests.every(r => r.headers.Authorization === 'Bearer test-token'));
  assert.ok(requests.every(r => r.url.startsWith('https://api.github.com/repos/fixture/data/')));
});

test('rejects incomplete multipart data and truncated trees', async () => {
  for (const mode of ['missing-part', 'truncated']) {
    const remote = new GitRemote({ repository: 'fixture/data', fetch: async url => {
      const path = new URL(url).pathname;
      if (path.includes('/ref/')) return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: commit } });
      if (path.includes('/commits/')) return response({ sha: commit, tree: { sha: tree } });
      if (path.endsWith(tree)) return response({ sha: tree, truncated: mode === 'truncated', tree: [
        { path: 'tablefile', type: 'tree', mode: '040000', sha: newer },
      ] });
      return response({ sha: newer, tree: [{ path: '0002', type: 'blob', mode: '100644', sha: commit }] });
    } });
    await assert.rejects(remote.read(), /truncated|part/i);
  }
});

test('does not force a Git reference past another writer', async () => {
  let patched = false;
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (_url, options) => {
    if (options.method === 'PATCH') patched = true;
    return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: newer } });
  } });
  await assert.rejects(remote.publish(publication()), GitConflictError);
  assert.equal(patched, false);
});

test('preserves a competing update made after the preflight read', async () => {
  let head = commit;
  let patches = 0;
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (url, options) => {
    if (options.method === 'PATCH') {
      patches++;
      assert.equal(JSON.parse(options.body).force, false);
      head = newer;
      return response({ message: 'Not a fast-forward' }, 422);
    }
    if (url.includes('/compare/')) return response({ status: 'diverged' });
    return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: head } });
  } });
  await assert.rejects(remote.publish(publication()), GitConflictError);
  assert.equal(head, newer);
  assert.equal(patches, 1);
});

test('recognizes an acknowledged publication followed by another writer', async () => {
  let patches = 0;
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (url, options) => {
    if (options.method === 'PATCH') patches++;
    if (url.includes('/compare/')) {
      assert.ok(url.endsWith(`${prepared}...${newer}`));
      return response({ status: 'ahead' });
    }
    return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: newer } });
  } });
  assert.equal(await remote.publish(publication()), newer);
  assert.equal(patches, 0);
});

test('recovers a lost publish acknowledgement by reading the exact prepared commit', async () => {
  let head = commit;
  let patches = 0;
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (_url, options) => {
    if (options.method === 'PATCH') {
      patches++;
      assert.deepEqual(JSON.parse(options.body), { sha: prepared, force: false });
      head = prepared;
      throw Error('Connection lost after update');
    }
    return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: head } });
  } });
  assert.equal(await remote.publish(publication()), prepared);
  assert.equal(await remote.publish(publication()), prepared);
  assert.equal(patches, 1);
});

test('retains an uncertain publish outcome when readback is unavailable', async () => {
  let reads = 0;
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (_url, options) => {
    if (options.method === 'PATCH' || reads++) throw Error('Offline');
    return response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: commit } });
  } });
  await assert.rejects(remote.publish(publication()), GitOutcomeUnknownError);
});

test('prepares a native tree and commit without updating its reference', async () => {
  const requests = [];
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, method: options.method, body });
    if (url.endsWith('/blobs')) return response({ sha: oid(Buffer.from(body.content, 'base64')) }, 201);
    if (url.endsWith('/trees')) return response({ sha: tree }, 201);
    if (url.endsWith('/commits')) return response({ sha: prepared }, 201);
    assert.fail(`Unexpected request ${url}`);
  } });
  const plan = await remote.prepare([{ key: 'manifest', bytes: bytes('native manifest') }], commit, { name: 'Tester', email: 'tester@example.invalid' });
  assert.deepEqual(plan, { ...publication(), tree });
  const createdCommit = requests.find(r => r.url.endsWith('/commits')).body;
  assert.deepEqual(createdCommit.parents, [commit]);
  assert.equal(createdCommit.tree, tree);
  assert.equal(requests.some(r => r.method === 'PATCH'), false);
});

test('refuses to publish a prepared commit through a different repository', async () => {
  const remote = new GitRemote({ repository: 'fixture/data', token: () => 'test-token', fetch: async (_url, options) =>
    response({ ref: 'refs/dolt/data', object: { type: 'commit', sha: options.method === 'PATCH' ? prepared : commit } }),
  });
  await assert.rejects(remote.publish({ base: commit, commit: prepared, repository: 'another/data', ref: 'refs/dolt/data' }), /prepared.*repository/i);
});
