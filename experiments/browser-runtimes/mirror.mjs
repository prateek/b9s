import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-runtimes');
const recorded = new Map(JSON.parse(readFileSync(new URL('./trynix-assets.json', import.meta.url))).assets.map(asset => [asset.url, asset.sha256]));
mkdirSync(`${root}/http-cache`, { recursive: true });
export async function mirror() {
  const server = createServer(async (req, res) => {
    try {
      let bytes, type;
      if (req.url === '/probe/bd' || req.url === '/probe/b9s') {
        bytes = readFileSync(`${root}/sources/linux/${req.url.split('/').at(-1)}`);
        type = 'application/octet-stream';
      } else if (req.url === '/probe/seed.tar') {
        bytes = readFileSync(`${root}/seed.tar`);
        type = 'application/octet-stream';
      } else {
        const url = `https://trynix.dev${req.url}`;
        if (!recorded.has(url)) throw Error(`Unrecorded TryNix asset: ${url}`);
        const key = createHash('sha256').update(url).digest('hex');
        const file = `${root}/http-cache/${key}`;
        if (!existsSync(file)) {
          const response = await fetch(url);
          if (!response.ok) throw Error(`${response.status} ${url}`);
          writeFileSync(file, Buffer.from(await response.arrayBuffer()));
          writeFileSync(`${file}.json`, JSON.stringify({ url, type: response.headers.get('content-type') }));
        }
        bytes = readFileSync(file);
        if (createHash('sha256').update(bytes).digest('hex') !== recorded.get(url)) throw Error(`TryNix asset changed: ${url}`);
        type = JSON.parse(readFileSync(`${file}.json`)).type;
        if (/\/boot\.js(?:\?|$)/.test(req.url)) bytes = Buffer.from(bytes.toString().replace('const mod = await filesystem;', 'const mod = await filesystem; window.probeFS = mod.FS;'));
        if (type?.includes('text/html')) bytes = Buffer.from(bytes.toString().replace('<script src="coi-serviceworker.js"></script>', ''));
      }
      res.writeHead(200, { 'content-type': type || 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      res.end(bytes);
    } catch (error) { console.error(error); res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
