import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeNative } from '../src/native-sync.mjs';
import * as nativeSync from '../src/native-sync.mjs';
import { GitOutcomeUnknownError, GitConflictError } from '../src/git-remote.mjs';

function fixture() {
  const events = [], values = new Map();
  const plan = { repository: 'fixture/data', ref: 'refs/dolt/data', base: 'base', commit: 'prepared' };
  const options = {
    identity: { name: 'Tester', email: 'tester@example.invalid' },
    state: {
      get: async key => values.get(key),
      set: async (key, value) => { events.push(`save:${key}`); values.set(key, value); },
    },
    runtime: {
      previewMerge: async () => { events.push('preview'); return { ours: 'local-head', theirs: 'remote-head', tables: [] }; },
      mergeRemote: async () => { events.push('merge'); },
      preparePush: async () => { events.push('transfer'); return { changed: true, head: 'native-head', entries: [] }; },
    },
    remote: {
      read: async () => { events.push('read'); return { commit: 'base', entries: [] }; },
      prepare: async () => { events.push('prepare'); return plan; },
      publish: async received => { assert.equal(received, plan); events.push('publish'); return 'prepared'; },
    },
  };
  return { options, events, values, plan };
}

function resolutionFixture() {
  const f = fixture();
  f.options.resolution = { key: 'reviewed-001', ours: 'local', theirs: 'remote', choices: [{ table: 'issues', id: 'conflict', side: 'theirs' }] };
  let recorded = false;
  f.options.runtime.resolutionReceipt = async () => { f.events.push('receipt'); return { state: recorded ? 'recorded' : 'absent' }; };
  f.options.runtime.resolveMerge = async () => { f.events.push('resolve'); recorded = true; return { ok: true }; };
  return f;
}

test('journals reviewed resolution before applying it and clears it after confirmation', async () => {
  const { options, events, values } = resolutionFixture();
  await nativeSync.resolveNative(options);
  assert.ok(events.indexOf('save:resolution') < events.indexOf('resolve'));
  assert.equal(values.get('resolution'), null);
  assert.equal(events.includes('publish'), false);
});

test('resolution retry confirms an existing native receipt without replay or network', async () => {
  const { options, events, values } = resolutionFixture();
  const receipt = options.runtime.resolutionReceipt;
  const apply = options.runtime.resolveMerge;
  let closed = false;
  options.runtime.resolveMerge = async () => { await apply(); closed = true; throw Error('Worker disconnected'); };
  options.runtime.resolutionReceipt = async () => { if (closed) throw Error('Worker closed'); return receipt(); };
  await assert.rejects(nativeSync.resolveNative(options), /unresolved/);
  assert.equal(values.get('resolution').resolution.key, 'reviewed-001');
  closed = false;
  events.length = 0;
  await nativeSync.resolveNative({ ...options, resolution: undefined });
  assert.equal(values.get('resolution'), null);
  assert.equal(events.includes('resolve'), false);
  assert.equal(events.includes('read'), false);
});

test('definitively rejected resolution clears pending state for another review', async () => {
  const { options, values } = resolutionFixture();
  options.runtime.resolveMerge = async () => { throw Error('Reviewed heads changed'); };
  await assert.rejects(nativeSync.resolveNative(options), /Reviewed heads changed/);
  assert.equal(values.get('resolution'), null);
});

test('failed resolution journaling cannot execute a native mutation', async () => {
  const { options, events } = resolutionFixture();
  options.state.set = async () => { throw Error('Storage quota'); };
  await assert.rejects(nativeSync.resolveNative(options), /Storage quota/);
  assert.equal(events.includes('resolve'), false);
});

test('a pending resolution cannot be replaced by another set of choices', async () => {
  const { options, values, events } = resolutionFixture();
  values.set('resolution', { resolution: options.resolution, identity: options.identity, branch: 'main' });
  await assert.rejects(nativeSync.resolveNative(options), /Retry the unresolved/);
  assert.equal(events.includes('resolve'), false);
});

test('uncertain native working state retains choices without fetching or applying', async () => {
  const { options, values, events } = resolutionFixture();
  options.runtime.resolutionReceipt = async () => ({ state: 'unknown' });
  await assert.rejects(nativeSync.resolveNative(options), /unresolved/);
  assert.equal(values.get('resolution').resolution.key, 'reviewed-001');
  assert.equal(events.includes('read'), false);
  assert.equal(events.includes('resolve'), false);
});

test('returns a reviewable conflict preview before merging or uploading', async () => {
  const { options, events } = fixture();
  const preview = { ours: 'local-head', theirs: 'remote-head', tables: [{ name: 'issues', dataConflicts: 1, schemaConflicts: 0, rows: [] }] };
  options.runtime.previewMerge = async () => preview;
  await assert.rejects(synchronizeNative(options), error => {
    assert.equal(error.name, 'NativeMergeConflictError');
    assert.deepEqual(error.preview, preview);
    return true;
  });
  assert.equal(events.includes('merge'), false);
  assert.equal(events.includes('prepare'), false);
  assert.equal(events.includes('publish'), false);
});

test('persists the prepared publication before updating the Git ref', async () => {
  const { options, events, values } = fixture();
  const result = await synchronizeNative(options);
  assert.equal(result.commit, 'prepared');
  assert.ok(events.indexOf('save:publication') < events.indexOf('publish'));
  assert.equal(values.get('publication'), null);
  assert.equal(values.get('last-sync').head, 'native-head');
});

test('retains an uncertain publication and retries that exact plan after reopening', async () => {
  const { options, events, values, plan } = fixture();
  const publish = options.remote.publish;
  options.remote.publish = async () => { throw new GitOutcomeUnknownError(plan); };
  await assert.rejects(synchronizeNative(options), GitOutcomeUnknownError);
  assert.equal(values.get('publication').plan, plan);
  options.remote.publish = publish;
  events.length = 0;
  await synchronizeNative(options);
  assert.equal(events[0], 'publish');
  assert.equal(events.includes('prepare'), false);
  assert.equal(values.get('publication'), null);
});

test('does not publish when saving recovery state fails', async () => {
  const { options, events } = fixture();
  options.state.set = async () => { throw Error('Storage quota'); };
  await assert.rejects(synchronizeNative(options), /Storage quota/);
  assert.equal(events.includes('publish'), false);
});

test('does not upload or publish when native merge rejects conflicting edits', async () => {
  const { options, events } = fixture();
  options.runtime.mergeRemote = async () => { throw Error('Native merge conflict'); };
  await assert.rejects(synchronizeNative(options), /merge conflict/);
  assert.equal(events.includes('prepare'), false);
  assert.equal(events.includes('publish'), false);
});

test('retains a competing-ref failure for explicit recovery', async () => {
  const { options, values, plan } = fixture();
  options.remote.publish = async () => { throw new GitConflictError('base', 'other'); };
  await assert.rejects(synchronizeNative(options), GitConflictError);
  assert.equal(values.get('publication').plan, plan);
});

test('avoids a Git commit when native history is already synchronized', async () => {
  const { options, events, values } = fixture();
  options.runtime.preparePush = async () => ({ changed: false, head: 'native-head', entries: [] });
  const result = await synchronizeNative(options);
  assert.equal(result.commit, 'base');
  assert.equal(events.includes('prepare'), false);
  assert.equal(events.includes('publish'), false);
  assert.equal(values.get('last-sync').head, 'native-head');
});

test('does not report synchronization when the runtime lacks the transfer contract', async () => {
  const { options, values } = fixture();
  options.runtime.preparePush = async () => ({ head: 'native-head', entries: [] });
  await assert.rejects(synchronizeNative(options), /runtime/i);
  assert.equal(values.has('last-sync'), false);
});
