import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { gitAPIFixture } from './git-api-fixture.mjs';
import { synchronize } from './native-readback.mjs';

const root = resolve(process.argv[2]);
const source = resolve(process.argv[3]);
const evidence = resolve(process.argv[4]);
const livePublic = process.env.B9S_LIVE_PUBLIC === '1';
mkdirSync(evidence, { recursive: true });
const fixture = await gitAPIFixture(source, evidence);
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET' || !path.startsWith('/b9s/')) { response.writeHead(404).end(); return; }
  if (path === '/b9s/native-config.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ schema: 1, projects: [{ key: 'demo', name: 'Synthetic Beads demo', source: livePublic
      ? { repository: 'prateek/b9s', ref: 'refs/dolt/demo' } : { repository: 'fixture/data' } }],
      identity: { name: 'Must remain read-only', email: 'fixture@example.invalid' } }));
    return;
  }
  const file = resolve(root, path.slice(5) || 'index.html');
  if (!file.startsWith(`${root}/`)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream');
    response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
    fixture.restore();
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const requests = [], errors = [];
      context.on('request', request => {
        if ([fixture.origin, 'https://api.github.com', 'https://raw.githubusercontent.com'].includes(new URL(request.url()).origin)) {
          requests.push({ method: request.method(), authorization: request.headers().authorization });
        }
      });
      // Real cross-origin fetches survive service-worker activation, unlike intercepted routes in WebKit.
      if (!livePublic) await context.addInitScript(origin => {
        const fetcher = window.fetch.bind(window);
        window.fetch = (url, options) => fetcher(typeof url === 'string'
          ? url.replace('https://api.github.com', origin).replace('https://raw.githubusercontent.com', `${origin}/raw`)
          : url, options);
      }, fixture.origin);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/b9s/`);
      await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
      await expect(page.locator('#banner')).toContainText('Read-only');
      await expect(page.locator('#native-offline-feedback')).toContainText('Ready for offline use', { timeout: 150000 });
      await expect(page.getByRole('button', { name: 'Create issue', exact: true })).toHaveCount(0);
      await page.locator('#treeRows .row[data-id="browser-b"]').click();
      await expect(page.locator('.detail')).toContainText('Native release fixture comment');
      assert.equal(await page.locator('input[type=password]').count(), 0);
      const rejected = await page.evaluate(async () => {
        const worker = new Worker('./native-worker.mjs', { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Worker guard timeout')), 5000);
            worker.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
            worker.postMessage({ id: 1, op: 'request', payload: { op: 'write', command: {} } });
          });
        } finally { worker.terminate(); }
      });
      assert.match(JSON.stringify(rejected), /read-only/);
      await page.keyboard.press('Escape');
      let expectedTitle = 'Native browser task';
      if (!livePublic) {
        assert.ok(process.env.B9S_TEST_BD, 'Native refresh validation requires B9S_TEST_BD');
        const initial = synchronize({ remote: fixture.remote, bd: process.env.B9S_TEST_BD, work: `${evidence}/${engine}-before` });
        expectedTitle = `Refreshed by native bd in ${engine}`;
        const updated = synchronize({ remote: fixture.remote, bd: process.env.B9S_TEST_BD, work: `${evidence}/${engine}-updated`,
          command: { op: 'update', base: initial.revision, ids: ['browser-b'], fields: { title: expectedTitle } } });
        assert.notEqual(updated.revision, initial.revision);
        assert.equal(updated.snapshot.issues.find(issue => issue.id === 'browser-b').title, expectedTitle);
        const beforeRefresh = requests.length;
        await page.getByRole('button', { name: 'Refresh from GitHub' }).click();
        try {
          await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThan(beforeRefresh);
          await expect(page.locator('#treeRows')).toContainText(expectedTitle, { timeout: 150000 });
        }
        catch (error) {
          await page.screenshot({ path: `${evidence}/${engine}-refresh-failure.png` });
          writeFileSync(`${evidence}/${engine}-refresh-failure.txt`, await page.locator('body').innerText());
          throw error;
        }
      }
      if (!livePublic) {
        fixture.setUnavailable(true);
        await page.getByRole('button', { name: 'Refresh from GitHub' }).click();
        await expect(page.getByRole('button', { name: 'Refresh from GitHub' })).toBeEnabled({ timeout: 150000 });
        await expect(page.locator('#app')).toContainText('Remote refresh failed');
        await expect(page.locator('#treeRows')).toContainText(expectedTitle);
        if (engine === 'webkit') await new Promise(resolve => server.close(resolve));
        else await context.setOffline(true);
        await page.goto(`${origin}/b9s/index.html`);
        await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
        await expect(page.locator('#treeRows')).toContainText(expectedTitle);
      }
      await page.screenshot({ path: `${evidence}/${engine}.png` });
      assert.deepEqual(errors, []);
      assert.ok(requests.length > 0 && requests.every(r => r.method === 'GET' && !r.authorization));
      results.push({ engine, passed: true, livePublic, anonymousNativeRead: true, workerRejectsWrites: true,
        ...(!livePublic ? { nativeRefresh: true, unavailableRemoteRetainsData: true, canonicalURLCache: true, coldOfflineStartup: true } : {}) });
    } finally { await browser.close(); }
  }
} finally {
  writeFileSync(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  await fixture.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(results));
