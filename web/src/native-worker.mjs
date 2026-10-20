import './wasm_exec.js';
import { openNativeStore } from './native-store.mjs';
import { readOnly, assertNativeOperation } from './native-policy.mjs';

let started = false;
let ready;
let lockName;

async function initialize({ name, entries, branch }) {
  globalThis.nativeStore = await openNativeStore(name);
  if (!(await nativeStore.call('exists', 'manifest')).exists) {
    if (!entries?.length) throw Error('No native Beads database is available locally');
    await nativeStore.seed(entries);
  }
  globalThis.nativeBranch = branch || 'main';
  const go = new Go();
  go.env = { DOLT_EVENTS_EMITTER: 'null', HOME: '/tmp', TMPDIR: '/tmp' };
  const manifestResponse = await fetch(new URL('./runtime.json', import.meta.url));
  if (!manifestResponse.ok) throw Error(`Loading runtime manifest: HTTP ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  if (manifest.schema !== 1 || manifest.kind !== 'b9s-native') throw Error('The site does not contain a production Beads runtime');
  const response = await fetch(new URL('./native.wasm.gz', import.meta.url));
  if (!response.ok) throw Error(`Loading Beads runtime: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const checksum = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  let loaded;
  if (checksum === manifest.files['native.wasm.gz']) {
    const decoded = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    loaded = await WebAssembly.instantiateStreaming(new Response(decoded, { headers: { 'Content-Type': 'application/wasm' } }), go.importObject);
  } else if (bytes.byteLength === manifest.wasm.bytes && checksum === manifest.wasm.sha256) {
    loaded = await WebAssembly.instantiate(bytes, go.importObject);
  } else {
    throw Error('The Beads runtime checksum does not match this site build');
  }
  const { instance } = loaded;
  let exited = false;
  let failure;
  go.run(instance).then(() => {
    exited = true;
    failure = globalThis.nativeFailure;
  }).catch(error => { exited = true; failure = error.message; });
  const deadline = Date.now() + 120000;
  while (!globalThis.nativeCall) {
    if (exited) throw Error(failure || 'Beads runtime exited during initialization');
    if (Date.now() >= deadline) throw Error('Beads runtime initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

self.onmessage = async ({ data }) => {
  const { id, op, payload } = data;
  try {
    assertNativeOperation(readOnly, op, payload);
    if (op === 'initialize') {
      if (started) throw Error('Beads runtime is already initialized');
      if (!navigator.locks) throw Error('This browser does not support the locks required for native Beads storage');
      started = true;
      lockName = `b9s-native:${payload.name}`;
      ready = navigator.locks.request(lockName, () => initialize(payload));
      await ready;
      self.postMessage({ id, value: true });
      return;
    }
    if (!started) throw Error('Initialize the Beads runtime first');
    await ready;
    if (op === 'load-state' || op === 'save-state') {
      const value = await navigator.locks.request(lockName, () => op === 'load-state'
        ? nativeStore.loadState(payload.key) : nativeStore.saveState(payload.key, payload.value));
      self.postMessage({ id, value });
      return;
    }
    if (op === 'prepare-push' || op === 'merge-remote' || op === 'preview-merge' || op === 'resolve-merge') {
      const value = await navigator.locks.request(lockName, async () => {
        globalThis.remoteEntries = payload.entries;
        try {
          const result = JSON.parse(await nativeCall(JSON.stringify({
            op, branch: payload.branch || nativeBranch, identity: payload.identity, resolution: payload.resolution,
          })));
          return op === 'prepare-push' ? { ...result, entries: globalThis.preparedEntries } : result;
        } finally {
          globalThis.remoteEntries = undefined;
          globalThis.preparedEntries = undefined;
        }
      });
      self.postMessage({ id, value }, value.entries?.map(entry => entry.bytes.buffer) || []);
      return;
    }
    if (op !== 'request') throw Error(`Unknown worker operation: ${op}`);
    const value = await navigator.locks.request(lockName, async () => JSON.parse(await nativeCall(JSON.stringify(payload))));
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
