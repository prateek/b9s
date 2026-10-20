import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { synchronize } from './native-readback.mjs';

const runtime = resolve(process.env.B9S_RUNTIME_WORK);
const original = resolve(process.argv[2]);
const bd = resolve(process.env.B9S_NEWER_BD);
const work = mkdtempSync(`${runtime}/schema-`);
const remote = `${work}/remote.git`;
execFileSync('git', ['clone', '--mirror', original, remote], { timeout: 30000 });
const entries = () => {
  const git = (...args) => execFileSync('git', [`--git-dir=${remote}`, ...args], { timeout: 30000, maxBuffer: 64 << 20 });
  return git('ls-tree', '-r', 'refs/dolt/data').toString().trim().split('\n').map(line => {
    const [metadata, key] = line.split('\t');
    return { key, bytes: git('cat-file', 'blob', metadata.split(' ')[2]).toString('base64') };
  });
};
const before = entries();
const initial = synchronize({ remote, bd, work: `${work}/initial` });
synchronize({
  remote, bd, work: `${work}/upgrade`,
  command: { op: 'comment', key: 'schema-upgrade-test', base: initial.revision, ids: ['browser-b'], text: 'Newer native schema' },
});
const after = entries();
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<script type="module">import { openNativeRuntime } from "/native-client.mjs"; window.openNativeRuntime = openNativeRuntime;</script>');
    return;
  }
  const name = req.url.slice(1);
  const sources = new Set(['native-client.mjs', 'native-worker.mjs', 'native-store.mjs']);
  const artifacts = new Set(['native.wasm.gz', 'runtime.json', 'wasm_exec.js']);
  if (!sources.has(name) && !artifacts.has(name)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', extname(name) === '.json' ? 'application/json' : 'text/javascript');
  res.end(readFileSync(sources.has(name) ? `web/src/${name}` : `${runtime}/${name}`));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const evidence = [];
try {
  for (const [engine, kind] of Object.entries({ chromium, webkit })) {
    const browser = await kind.launch({ headless: true });
    const result = { engine, passed: false };
    evidence.push(result);
    try {
      const page = await browser.newPage();
      page.on('console', message => console.log(`${engine}: ${message.text()}`));
      page.on('pageerror', error => console.log(`${engine}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.openNativeRuntime);
      const observed = await page.evaluate(async ({ before, after }) => {
        const decode = entries => entries.map(({ key, bytes }) => ({ key, bytes: Uint8Array.from(atob(bytes), char => char.charCodeAt(0)) }));
        const client = await openNativeRuntime('schema-guard', decode(before));
        try {
          const original = await client.request({ op: 'export' });
          let error = '';
          try { await client.mergeRemote(decode(after), { name: 'Schema tester', email: 'schema@example.invalid' }); }
          catch (failure) { error = failure.message; }
          const retained = await client.request({ op: 'export' }).catch(failure => { throw Error(`After merge rejection (${error}): ${failure.message}`); });
          const head = await client.preparePush(decode(before)).catch(failure => ({ error: failure.message }));
          const issue = (await client.request({ op: 'issue', id: 'browser-b' }))[0];
          await client.request({ op: 'write', command: {
            op: 'comment', key: 'after-schema-rejection', ids: ['browser-b'],
            expected: { 'browser-b': issue.revision }, text: 'Local editing still works',
            actor: 'Schema tester', email: 'schema@example.invalid',
          } });
          const edited = (await client.request({ op: 'issue', id: 'browser-b' }))[0];
          return {
            error, unchanged: JSON.stringify(original) === JSON.stringify(retained), changed: head.changed,
            editable: edited.comments.some(comment => comment.text === 'Local editing still works'),
          };
        } finally { client.close(); }
      }, { before, after });
      Object.assign(result, observed);
      assert.match(observed.error, /remote database schema 72 differs from runtime 66/);
      assert.equal(observed.unchanged, true);
      assert.equal(observed.changed, false);
      assert.equal(observed.editable, true);
      result.passed = true;
    } finally {
      writeFileSync(`${work}/results.json`, JSON.stringify(evidence, null, 2));
      await browser.close();
    }
  }
  console.log(JSON.stringify({ work, evidence }));
} finally { await new Promise(resolve => server.close(resolve)); }
