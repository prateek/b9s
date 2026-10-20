import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const config = JSON.parse(readFileSync(`${root}/native-config.json`, 'utf8'));
assert.ok(config.projects.length && config.projects.every(project => project.bootstrap && !project.source),
  'This smoke test requires a synthetic bootstrap-only preview');
mkdirSync(evidence, { recursive: true });
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET' || !path.startsWith('/b9s/')) { response.writeHead(404).end(); return; }
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
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const requests = [], errors = [];
      page.on('request', request => requests.push(request.url()));
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/b9s/`);
      await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
      await expect(page.getByRole('button', { name: 'Switch project', exact: true })).toContainText('Synthetic Beads demo');
      await page.locator('#treeRows .row[data-id="browser-b"]').click();
      await page.locator('.detail .dacts [data-act="comment"]').click();
      await page.locator('#fComment').fill('Stored in the standalone preview');
      await page.locator('[data-sa="docomment"]').click();
      await expect(page.locator('.detail')).toContainText('Stored in the standalone preview');
      await page.reload();
      await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
      await page.locator('#treeRows .row[data-id="browser-b"]').click();
      await expect(page.locator('.detail')).toContainText('Stored in the standalone preview');
      await page.screenshot({ path: `${evidence}/${engine}.png` });
      assert.deepEqual(errors, []);
      assert.ok(requests.every(url => new URL(url).origin === origin && !new URL(url).pathname.includes('/api/')));
      results.push({ engine, passed: true, commentPersisted: true, applicationBackendRequests: 0 });
    } finally { await browser.close(); }
  }
} finally {
  writeFileSync(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(results));
