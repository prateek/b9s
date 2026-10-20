import { chromium, webkit } from '../../web/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-runtimes');
const doltlite = process.env.B9S_DOLTLITE_MODULE || `${root}/npm/node_modules/@dolthub/doltlite-wasm`;
const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
const files = {
  '/worker.mjs': resolve('experiments/browser-runtimes/lite-worker.mjs'),
  '/lite.wasm': `${root}/lite.wasm`, '/schema.json': `${root}/schema.json`,
  '/wasm_exec.js': `${goroot}/lib/wasm/wasm_exec.js`,
  '/doltlite/sqlite3.mjs': `${doltlite}/sqlite3.mjs`,
  '/doltlite/sqlite3.wasm': `${doltlite}/sqlite3.wasm`,
};
const server = createServer((req, res) => {
  const file = files[req.url];
  if (!file && req.url !== '/') { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', file?.endsWith('.wasm') ? 'application/wasm' : req.url === '/' ? 'text/html' : 'text/javascript');
  res.end(file ? readFileSync(file) : '<title>Beads core + DoltLite</title><pre id="results"></pre><script>window.worker=new Worker("/worker.mjs",{type:"module"}); window.run=cmd=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("worker request timed out")),30000);worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))};worker.postMessage(cmd)})</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engineName = process.argv[2] || 'chromium';
const browser = await ({ chromium, webkit }[engineName]).launch({ headless: true });
const evidence = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('console', msg => { if (msg.type() === 'error') console.log(msg.text().slice(0, 400)); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  async function run(command, expectedError) {
    const result = await page.evaluate(command => window.run(command), command);
    evidence.push({ command, result });
    console.log(JSON.stringify({ command, error: result.error, ms: result.ms }));
    if (expectedError) assert.match(result.error || '', expectedError);
    else assert.equal(result.error, undefined);
    return result;
  }
  for (const command of [
    { op: 'create', id: 'probe-a', title: 'Browser blocker' },
    { op: 'create', id: 'probe-b', title: 'Browser dependent' },
    { op: 'get', id: 'probe-a' },
    { op: 'update', id: 'probe-a', status: 'in_progress' },
    { op: 'comment', id: 'probe-a', text: 'Actual Beads core in WASM' },
    { op: 'depend', id: 'probe-b', target: 'probe-a' },
  ]) {
    await run(command);
  }
  await run({ op: 'create', id: 'probe-a', title: 'Duplicate' }, /already exists/);
  await run({ op: 'create', id: 'probe-invalid', title: '' }, /title/i);
  await run({ op: 'depend', id: 'probe-a', target: 'probe-b' }, /cycle/i);
  await run({ op: 'close', id: 'probe-b' }, /blocked/);
  const version = (await run({ op: 'version', id: 'probe-a' })).value;
  assert.match(version, /^-?\d+$/);
  await run({ op: 'close', id: 'probe-a', version: '1' }, /version/i);
  assert.equal((await run({ op: 'get', id: 'probe-a' })).value.status, 'in_progress');
  await run({ op: 'close', id: 'probe-a', version });
  await run({ op: 'close', id: 'probe-b' });
  assert.equal((await run({ op: 'get', id: 'probe-b' })).value.status, 'closed');
  const comments = (await run({ op: 'comments', id: 'probe-a' })).value;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, 'Actual Beads core in WASM');
  await run({ op: 'save' });
  await page.reload();
  assert.equal((await run({ op: 'get', id: 'probe-b' })).value.status, 'closed');
  assert.equal((await run({ op: 'comments', id: 'probe-a' })).value.length, 1);
  await run({ op: 'create', id: 'probe-after', title: 'Created after reload' });
  await run({ op: 'save' });
  await page.reload();
  assert.equal((await run({ op: 'get', id: 'probe-after' })).value.title, 'Created after reload');
  const trace = await page.evaluate(() => window.run({ op: 'trace' }));
  writeFileSync(`${root}/results/lite-${engineName}-trace.json`, JSON.stringify(trace, null, 2));
  await page.evaluate(evidence => {
    document.querySelector('pre').style.cssText = 'white-space:pre-wrap;font:14px system-ui';
    document.querySelector('pre').textContent = 'Native Beads core + DoltLite WASM\n\n' + evidence.map(({ command, result }) => `${command.op} ${command.id || ''}: ${result.error || 'OK'} (${result.ms?.toFixed(1) || '-'} ms)`).join('\n\n');
  }, evidence);
  await page.screenshot({ path: `${root}/results/lite-${engineName}.png`, fullPage: true });
} finally {
  writeFileSync(`${root}/results/lite-${engineName}.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
  server.close();
}
