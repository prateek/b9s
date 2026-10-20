export async function openNativeStore(name) {
  const opening = indexedDB.open(`b9s-native:${name}`, 2);
  opening.onupgradeneeded = () => {
    for (const store of ['blobs', 'state']) {
      if (!opening.result.objectStoreNames.contains(store)) opening.result.createObjectStore(store);
    }
  };
  const db = await request(opening);
  const changes = new BroadcastChannel('b9s-native-changes');
  const close = () => { db.close(); changes.close(); };
  db.onversionchange = close;

  async function transaction(mode, operation, name = 'blobs') {
    const tx = db.transaction(name, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || Error('Native store transaction aborted'));
      tx.onerror = () => reject(tx.error);
    });
    try {
      const result = await operation(tx.objectStore(name));
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  return {
    close,
    loadState: key => transaction('readonly', store => request(store.get(key)), 'state'),
    async saveState(key, value) {
      const result = await transaction('readwrite', store => request(store.put(value, key)), 'state');
      changes.postMessage(name);
      return result;
    },
    async call(op, key, bytes, expected, sources) {
      const result = await transaction(op === 'get' || op === 'exists' ? 'readonly' : 'readwrite', async store => {
        const current = await request(store.get(key));
        if (op === 'exists') return { exists: current !== undefined };
        if (op === 'get') return current || { missing: true };
        if (op === 'cas' && (current?.version || '') !== expected) {
          return { conflict: true, version: current?.version || '' };
        }
        if (op === 'concat') {
          const parts = await Promise.all(sources.map(source => request(store.get(source))));
          if (parts.some(part => !part)) throw Error('Missing source blob');
          bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.bytes.length, 0));
          let offset = 0;
          for (const part of parts) { bytes.set(part.bytes, offset); offset += part.bytes.length; }
        } else if (op !== 'put' && op !== 'cas') {
          throw Error(`Unknown native store operation: ${op}`);
        }
        if (!(bytes instanceof Uint8Array)) throw Error('Native blob must be bytes');
        const version = crypto.randomUUID();
        await request(store.put({ bytes, version }, key));
        return { version };
      });
      if (key === 'manifest' && ['put', 'cas', 'concat'].includes(op) && !result.conflict) changes.postMessage(name);
      return result;
    },
    async export() {
      return transaction('readonly', async store => {
        const keys = await request(store.getAllKeys());
        const values = await Promise.all(keys.map(key => request(store.get(key))));
        return keys.map((key, index) => ({ key, ...values[index] }));
      });
    },
    async seed(entries) {
      return transaction('readwrite', async store => {
        if (await request(store.count())) throw Error('Refusing to seed a nonempty native store');
        for (const { key, bytes } of entries) {
          if (typeof key !== 'string' || !(bytes instanceof Uint8Array)) throw Error('Invalid native blob');
          await request(store.add({ bytes, version: crypto.randomUUID() }, key));
        }
      });
    },
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
