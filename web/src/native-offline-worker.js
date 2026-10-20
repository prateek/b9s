/* BUILD */
const prefix = `b9s-native:${self.registration.scope}:`;
const cacheName = prefix + BUILD.version;
const configuration = new URL('native-config.json', self.registration.scope).href;
const assets = new Map(Object.entries(BUILD.assets).map(([path, descriptor]) => [
  new URL(path, self.registration.scope).href, descriptor,
]));
const index = new URL('index.html', self.registration.scope).href;

async function verified(response, descriptor) {
  if (!response.ok || response.type === 'opaque') throw Error('Offline asset could not be downloaded');
  const bytes = await response.clone().arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== descriptor.sha256 && !(hash === descriptor.decodedHash && bytes.byteLength === descriptor.decodedBytes)) {
    throw Error('Offline asset does not match this app version');
  }
  return response;
}

let preparing;
function prepareCache() {
  if (preparing) return preparing;
  preparing = (async () => {
    const cache = await caches.open(cacheName);
    for (const [url, descriptor] of assets) {
      if (await cache.match(url)) continue;
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(120000) });
      await cache.put(url, await verified(response, descriptor));
    }
    if (!(await cache.match(configuration))) {
      const response = await fetch(configuration, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error('Offline configuration is unavailable');
      await cache.put(configuration, response);
    }
  })().finally(() => { preparing = undefined; });
  return preparing;
}

self.addEventListener('install', event => {
  event.waitUntil(prepareCache());
});

self.addEventListener('message', event => {
  if (event.data?.op !== 'prepare-offline' || !event.ports[0]) return;
  event.waitUntil(prepareCache().then(
    () => event.ports[0].postMessage({ ok: true }),
    error => event.ports[0].postMessage({ error: error.message }),
  ));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const requested = url.href;
  if (requested === configuration) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return response;
        await cache.put(configuration, response.clone());
        return response;
      } catch {
        const cached = await cache.match(configuration);
        if (!cached) return Response.error();
        const headers = new Headers(cached.headers);
        headers.set('X-B9s-Offline', '1');
        return new Response(cached.body, { status: cached.status, headers });
      }
    })());
    return;
  }
  const key = event.request.mode === 'navigate' && url.pathname === new URL(self.registration.scope).pathname
    ? index : requested;
  if (!assets.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await verified(await fetch(key), assets.get(key));
    await cache.put(key, response.clone());
    return response;
  })());
});
