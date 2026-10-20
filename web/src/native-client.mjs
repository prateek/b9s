export async function openNativeRuntime(name, entries, branch = 'main') {
  const worker = new Worker(new URL('./native-worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map();
  let sequence = 0;
  let closed = false;

  function close(reason = 'Beads runtime closed') {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error(reason));
    }
    pending.clear();
  }

  worker.onerror = event => close(event.message || 'Beads runtime failed');
  worker.onmessageerror = () => close('Invalid message from Beads runtime');
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) request.reject(Error(data.error));
    else request.resolve(data.value);
  };

  function call(op, payload) {
    if (closed) return Promise.reject(Error('Beads runtime is closed'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => close('Beads runtime timed out; operation outcome is unknown'), 150000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, op, payload });
    });
  }

  try {
    await call('initialize', { name, entries, branch });
    return {
      request: payload => call('request', payload),
      state: {
        get: key => call('load-state', { key }),
        set: (key, value) => call('save-state', { key, value }),
      },
      preparePush: (entries, targetBranch = branch) => call('prepare-push', { entries, branch: targetBranch }),
      mergeRemote: (entries, identity, targetBranch = branch) => call('merge-remote', { entries, identity, branch: targetBranch }),
      previewMerge: (entries, identity, targetBranch = branch) => call('preview-merge', { entries, identity, branch: targetBranch }),
      resolveMerge: (entries, identity, resolution, targetBranch = branch) => call('resolve-merge', { entries, identity, resolution, branch: targetBranch }),
      resolutionReceipt: (identity, resolution, targetBranch = branch) => call('request', { op: 'resolution-receipt', identity, resolution, branch: targetBranch }),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
