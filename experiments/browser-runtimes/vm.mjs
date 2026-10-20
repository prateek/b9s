import { chromium, webkit } from '../../web/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { mirror } from './mirror.mjs';
import assert from 'node:assert/strict';

const root = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-runtimes');
const engineName = process.argv[2] || 'chromium';
const engine = { chromium, webkit }[engineName];
const evidence = { engine: engineName, seeded: process.env.B9S_VM_SEED === '1', commands: [], errors: [] };
mkdirSync(`${root}/results`, { recursive: true });
const browser = await engine.launch({ headless: true });
const site = await mirror();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route(/google-analytics|googletagmanager|doubleclick/, route => route.abort());
  const binary = readFileSync(`${root}/sources/linux/bd`);
  page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(String(error)));
  page.on('crash', () => { evidence.errors.push('renderer crashed'); console.log('renderer crashed'); });
  page.on('console', msg => { if (msg.type() === 'error') console.log(msg.text().slice(0, 500)); });
  const started = Date.now();
  await page.goto(`${site.url}/?pkg=glibc&pkg=git&boot=1`, { timeout: 120000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.trynix?.transcript().includes('welcome to the multiverse'), null, { timeout: 180000 });
  evidence.bootMs = Date.now() - started;
  console.log('boot', evidence.bootMs);
  await page.evaluate(async size => {
    const bytes = new Uint8Array(await (await fetch('/probe/bd')).arrayBuffer());
    window.probeFS.writeFile('/share/bd', bytes, { canOwn: true });
    window.probeFS.chmod('/share/bd', 0o755);
  }, binary.length);
  async function run(command, timeoutMs = 120000) {
    const start = Date.now();
    let timer;
    const result = await Promise.race([
      page.evaluate(async ({ command, timeoutMs }) => window.trynix.run(`export BD_DISABLE_METRICS=1 DO_NOT_TRACK=1 NO_COLOR=1 BD_NON_INTERACTIVE=1 GIT_AUTHOR_NAME=Probe GIT_AUTHOR_EMAIL=probe@example.invalid GIT_COMMITTER_NAME=Probe GIT_COMMITTER_EMAIL=probe@example.invalid; ${command}`, { timeoutMs }), { command, timeoutMs }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Browser stopped responding during: ${command}`)), timeoutMs + 5000); }),
    ]).finally(() => clearTimeout(timer));
    evidence.commands.push({ command, ms: Date.now() - start, ...result });
    console.log(JSON.stringify(evidence.commands.at(-1)));
    writeFileSync(`${root}/results/vm-${engineName}.json`, JSON.stringify(evidence, null, 2));
    return result;
  }
  await run('uname -a; free -m; ls /nix/store/*glibc*/lib/ld-linux-x86-64.so.2');
  await run(`date -s '@${Math.floor(Date.now() / 1000)}'`);
  await run('mkdir -p /lib64; ln -s /nix/store/*glibc*/lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2; export LD_LIBRARY_PATH=$(echo /nix/store/*glibc*/lib); /share/bd version');
  const prefix = 'cd /tmp/beads-probe; export LD_LIBRARY_PATH=$(echo /nix/store/*glibc*/lib); ';
  if (evidence.seeded) {
    await page.evaluate(async () => {
      window.probeFS.writeFile('/share/seed.tar', new Uint8Array(await (await fetch('/probe/seed.tar')).arrayBuffer()));
    });
    assert.equal((await run('mkdir -p /tmp/beads-probe; tar xf /share/seed.tar -C /tmp/beads-probe')).status, 0);
  } else {
    assert.equal((await run('mkdir -p /tmp/beads-probe; ' + prefix + '/share/bd init --prefix probe --skip-hooks --skip-agents --non-interactive', 120000)).status, 0);
  }
  for (const command of [
    '/share/bd create --id probe-a --title "Browser blocker" --json',
    '/share/bd create --id probe-b --title "Browser dependent" --json',
    '/share/bd update probe-a --status in_progress --json',
    '/share/bd comments add probe-a "Native Dolt in browser Linux"',
    '/share/bd dep add probe-b probe-a',
  ]) assert.equal((await run(prefix + command)).status, 0);
  const blocked = await run(prefix + '/share/bd close probe-b');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.output, /blocked/i);
  for (const command of ['/share/bd close probe-a', '/share/bd close probe-b']) {
    assert.equal((await run(prefix + command)).status, 0);
  }
  const exported = await run(prefix + '/share/bd export');
  assert.equal(exported.status, 0);
  const parseExport = output => output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).sort((a, b) => a.id.localeCompare(b.id));
  const expected = parseExport(exported.output);
  assert.equal(expected.length, 2);
  await page.evaluate(async () => {
    window.probeFS.writeFile('/share/b9s', new Uint8Array(await (await fetch('/probe/b9s')).arrayBuffer()), { canOwn: true });
    window.probeFS.chmod('/share/b9s', 0o755);
  });
  assert.equal((await run('ifconfig lo 127.0.0.1 up')).status, 0);
  assert.equal((await run(prefix + 'PATH=/share:$PATH B9S_TEST_MODE=1 /share/b9s web --no-token --listen 127.0.0.1:8090 >/tmp/b9s.log 2>&1 & echo $! >/tmp/b9s.pid')).status, 0);
  const api = await run('for n in $(seq 1 45); do if wget -qO /tmp/snapshot.json http://127.0.0.1:8090/api/snapshot; then cat /tmp/snapshot.json; exit 0; fi; if ! kill -0 "$(cat /tmp/b9s.pid)" 2>/dev/null; then break; fi; sleep 1; done; ps; cat /tmp/b9s.log; exit 1');
  evidence.b9s = { passed: api.status === 0 && api.output.includes('Browser blocker'), result: api };
  assert.equal((await run('if kill -0 "$(cat /tmp/b9s.pid)" 2>/dev/null; then kill "$(cat /tmp/b9s.pid)"; fi; for n in 1 2 3 4 5; do if ! kill -0 "$(cat /tmp/b9s.pid)" 2>/dev/null; then exit 0; fi; sleep 1; done; exit 1')).status, 0);
  await page.evaluate(() => {
    window.probeFS.writeFile('/share/state.tar', new Uint8Array());
    window.probeFS.chmod('/share/state.tar', 0o666);
  });
  assert.equal((await run('tar cf /share/state.tar -C /tmp beads-probe')).status, 0);
  evidence.archiveBytes = await page.evaluate(async () => {
    const bytes = window.probeFS.readFile('/share/state.tar');
    const request = indexedDB.open('native-beads-probe', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(bytes, 'archive');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
    return bytes.length;
  });
  const archive = await page.evaluate(() => {
    const bytes = window.probeFS.readFile('/share/state.tar');
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  });
  writeFileSync(`${root}/results/state-${engineName}.tar`, Buffer.from(archive, 'base64'));
  await page.goto(`${site.url}/?pkg=glibc&pkg=git&boot=1`, { timeout: 120000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.trynix?.transcript().includes('welcome to the multiverse'), null, { timeout: 120000 });
  await page.evaluate(async () => {
    const request = indexedDB.open('native-beads-probe', 1);
    const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
    const get = db.transaction('state').objectStore('state').get('archive');
    const bytes = await new Promise(resolve => { get.onsuccess = () => resolve(get.result); });
    db.close();
    window.probeFS.writeFile('/share/state.tar', bytes, { canOwn: true });
    window.probeFS.writeFile('/share/bd', new Uint8Array(await (await fetch('/probe/bd')).arrayBuffer()), { canOwn: true });
    window.probeFS.chmod('/share/bd', 0o755);
  });
  assert.equal((await run('mkdir -p /lib64; ln -s /nix/store/*glibc*/lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2; tar xf /share/state.tar -C /tmp')).status, 0);
  const restored = await run(prefix + '/share/bd export');
  assert.equal(restored.status, 0);
  assert.match(restored.output, /Native Dolt in browser Linux/);
  assert.match(restored.output, /"status":"closed"/);
  assert.deepEqual(parseExport(restored.output), expected);
  evidence.nativePersistence = true;
  evidence.passed = evidence.b9s.passed;
  if (!evidence.passed) process.exitCode = 1;
  await page.screenshot({ path: `${root}/results/vm-${engineName}.png` });
} catch (error) {
  evidence.failure = String(error);
  if (page && !page.isClosed() && !String(error).includes('stopped responding')) {
    evidence.page = await page.locator('body').innerText().catch(() => '');
    evidence.transcript = await page.evaluate(() => window.trynix?.transcript()).catch(() => '');
    await page.screenshot({ path: `${root}/results/vm-${engineName}-failure.png` }).catch(() => {});
  }
  console.log(evidence.failure);
  process.exitCode = 1;
} finally {
  writeFileSync(`${root}/results/vm-${engineName}.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
  site.close();
}
