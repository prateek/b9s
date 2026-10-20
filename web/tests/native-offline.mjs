import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

function fixture() {
  const scope = 'https://fixture.invalid/b9s/';
  const handlers = new Map(), stores = new Map(), requests = [];
  const files = new Map([['index.html', 'app'], ['app.js', 'script'], ['native-config.json', '{"schema":1}']]);
  const assets = Object.fromEntries([...files].filter(([key]) => key !== 'native-config.json').map(([key, body]) => [
    key, { sha256: createHash('sha256').update(body).digest('hex') },
  ]));
  let network = true;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        match: async key => entries.get(key)?.clone(),
        put: async (key, response) => { entries.set(key, response.clone()); },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
  };
  runInNewContext(readFileSync(new URL('../src/native-offline-worker.js', import.meta.url), 'utf8'), {
    BUILD: { version: 'test', assets }, caches, crypto: webcrypto,
    URL, Response, Headers, Uint8Array, AbortSignal,
    self: {
      registration: { scope }, location: new URL(scope),
      clients: { claim: async () => {} },
      addEventListener: (name, handler) => handlers.set(name, handler),
    },
    fetch: async input => {
      const url = typeof input === 'string' ? input : input.url;
      requests.push(url);
      if (!network) throw Error('Disconnected');
      const body = files.get(url.slice(scope.length));
      return new Response(body, { status: body === undefined ? 404 : 200 });
    },
  });
  return {
    files, requests, stores, offline() { network = false; },
    async prepare() {
      let work, message;
      handlers.get('message')({
        data: { op: 'prepare-offline' }, ports: [{ postMessage: value => { message = value; } }],
        waitUntil: promise => { work = promise; },
      });
      await work;
      return message;
    },
    fetch(path, method = 'GET') {
      let response;
      handlers.get('fetch')({
        request: { url: new URL(path, scope).href, method, mode: 'cors' },
        respondWith: promise => { response = promise; },
      });
      return response;
    },
  };
}

test('failed integrity check remains retryable without caching the wrong asset', async () => {
  const f = fixture();
  f.files.set('app.js', 'wrong build');
  assert.match((await f.prepare()).error, /does not match/);
  assert.equal([...f.stores.values()][0].has('https://fixture.invalid/b9s/app.js'), false);
  f.files.set('app.js', 'script');
  assert.equal((await f.prepare()).ok, true);
  f.offline();
  assert.equal(await (await f.fetch('app.js')).text(), 'script');
});

test('cached configuration explicitly identifies disconnected startup', async () => {
  const f = fixture();
  assert.equal((await f.prepare()).ok, true);
  f.offline();
  const response = await f.fetch('native-config.json');
  assert.equal(response.headers.get('X-B9s-Offline'), '1');
  assert.equal(await response.text(), '{"schema":1}');
});

test('issue exports, GitHub requests and writes bypass the offline cache', async () => {
  const f = fixture();
  await f.prepare();
  const count = f.requests.length;
  assert.equal(f.fetch('native-fixture.json'), undefined);
  assert.equal(f.fetch('https://api.github.com/repos/private/data'), undefined);
  assert.equal(f.fetch('app.js', 'POST'), undefined);
  assert.equal(f.requests.length, count);
});
