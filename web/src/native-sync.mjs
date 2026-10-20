import { GitConflictError } from './git-remote.mjs';

export class NativeMergeConflictError extends Error {
  constructor(preview) {
    super('Review the conflicting local and remote changes before synchronizing');
    this.name = 'NativeMergeConflictError';
    this.preview = preview;
  }
}

export async function resolveNative({ runtime, remote, state, identity, resolution, branch = 'main', onStatus = () => {} }) {
  let pending = await state.get('resolution');
  if (pending && resolution) throw Error('Retry the unresolved resolution before choosing another');
  if (!pending) {
    if (!resolution) throw Error('No reviewed resolution is available');
    pending = { resolution, identity, branch };
    await state.set('resolution', pending);
  }
  const receipt = () => runtime.resolutionReceipt(pending.identity, pending.resolution, pending.branch);
  const complete = async () => {
    await state.set('resolution', null);
    onStatus('Resolved locally. Sync with GitHub to publish.');
  };
  try {
    onStatus('Checking the reviewed resolution…');
    const status = await receipt();
    if (status.state === 'recorded') return await complete();
    if (status.state !== 'absent') throw Error('Native working state needs recovery');
    onStatus('Checking the remote before applying reviewed choices…');
    const incoming = await remote.read();
    onStatus('Applying reviewed choices locally…');
    await runtime.resolveMerge(incoming.entries, pending.identity, pending.resolution, pending.branch);
    return await complete();
  } catch (error) {
    let status;
    try { status = await receipt(); } catch { /* Retain choices when the worker cannot confirm their outcome. */ }
    if (status?.state === 'recorded') return await complete();
    if (status?.state === 'absent') {
      await state.set('resolution', null);
      throw error;
    }
    throw Error(`Resolution outcome unresolved: ${error instanceof Error ? error.message : String(error)}. Retry the same choices.`);
  }
}

export async function synchronizeNative({ runtime, remote, state, identity, branch = 'main', reconcile = false, onStatus = () => {} }) {
  async function complete(publication, commit) {
    const result = { commit, head: publication.head, at: new Date().toISOString() };
    await state.set('last-sync', result);
    await state.set('publication', null);
    onStatus('Published the prepared changes.');
    return result;
  }

  const pending = await state.get('publication');
  if (pending) {
    onStatus('Checking the previous publication…');
    try {
      return await complete(pending, await remote.publish(pending.plan));
    } catch (error) {
      if (!(error instanceof GitConflictError) || !reconcile) throw error;
      await state.set('superseded-publication', pending);
      await state.set('publication', null);
    }
  }
  onStatus('Fetching native Beads data…');
  const incoming = await remote.read();
  onStatus('Checking for conflicting changes…');
  const preview = await runtime.previewMerge(incoming.entries, identity, branch);
  if (preview.tables.length) throw new NativeMergeConflictError(preview);
  onStatus('Merging remote changes…');
  await runtime.mergeRemote(incoming.entries, identity, branch);
  const prepared = await runtime.preparePush(incoming.entries, branch);
  if (typeof prepared.changed !== 'boolean') throw Error('The native runtime does not support this synchronization contract; rebuild the app and runtime together');
  if (!prepared.changed) {
    const result = { commit: incoming.commit, head: prepared.head, at: new Date().toISOString() };
    await state.set('last-sync', result);
    onStatus('The local history matches the fetched remote.');
    return result;
  }
  onStatus('Preparing Git objects…');
  const plan = await remote.prepare(prepared.entries, incoming.commit, identity);
  const publication = { plan, head: prepared.head };
  await state.set('publication', publication);
  onStatus('Publishing the prepared changes…');
  return complete(publication, await remote.publish(plan));
}
