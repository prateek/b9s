import { chromium, webkit } from '../../web/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { synchronize, nativeEnv } from '../../web/tests/native-readback.mjs';
import { exerciseNativeMutations } from '../../web/tests/native-mutations.mjs';
import { gitAPIFixture } from '../../web/tests/git-api-fixture.mjs';

const root = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-runtime-repro2');
const remote = resolve(process.argv[3]);
const git = (...args) => execFileSync('git', [`--git-dir=${remote}`, ...args], { maxBuffer: 64 << 20, timeout: 30000 });
const entries = git('ls-tree', '-r', 'refs/dolt/data').toString().trim().split('\n').map(line => {
  const [metadata, key] = line.split('\t');
  return { key, bytes: git('cat-file', 'blob', metadata.split(' ')[2]).toString('base64') };
});
const server = createServer((req, res) => {
  if (req.url === '/native.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(entries)); }
  if (req.url === '/' || req.url === '/?write=1' || req.url === '/?runtime=1') {
    res.setHeader('content-type', 'text/html');
    return res.end(`<script src="/wasm_exec.js"></script><script type="module">
      import { openNativeStore } from '/native-store.mjs';
      import { openNativeRuntime } from '/native-client.mjs';
      window.openNativeStore = openNativeStore;
      window.persistentWrite = location.search === '?write=1';
      window.nativeRuntime = location.search === '?runtime=1';
      try {
        if (window.nativeRuntime) {
          window.runtime = await openNativeRuntime('fixture');
          window.nativeCall = async payload => JSON.stringify(await runtime.request(JSON.parse(payload)));
        } else {
        window.nativeStore = await openNativeStore('fixture');
        if (!(await nativeStore.call('exists','manifest')).exists) {
          const entries = await (await fetch('/native.json')).json();
          await nativeStore.seed(entries.map(e=>({key:e.key,bytes:Uint8Array.from(atob(e.bytes),c=>c.charCodeAt(0))})));
        }
        const go = new Go();
        go.env={DOLT_EVENTS_EMITTER:'null',HOME:'/tmp',TMPDIR:'/tmp'};
        const {instance} = await WebAssembly.instantiateStreaming(fetch('/persistent.wasm'),go.importObject);
        await go.run(instance);
        window.result=JSON.parse(window.persistentResult);
        }
      } catch(error) { window.result={error:String(error)}; }
    </script>`);
  }
  const path = req.url === '/persistent.wasm' ? `${root}/persistent.wasm`
    : ['/native.wasm.gz', '/runtime.json'].includes(req.url) ? `${root}${req.url}`
    : req.url === '/wasm_exec.js' ? `${root}/wasm_exec.js`
      : req.url === '/native-store.mjs' ? resolve('web/src/native-store.mjs') : null;
  const servedPath = ['/native-worker.mjs', '/native-client.mjs', '/git-remote.mjs'].includes(req.url) ? resolve(`web/src${req.url}`) : path;
  if (!servedPath) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  res.end(readFileSync(servedPath));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.argv[2] || 'chromium';
const github = process.env.B9S_NATIVE_GIT ? await gitAPIFixture(remote, root) : undefined;
const browser = await ({ chromium, webkit }[engine]).launch({ headless: true });
const evidence = { engine, sourceRef: git('rev-parse', 'refs/dolt/data').toString().trim(), objects: entries.length };
try {
  const page = await browser.newPage();
  page.on('console', msg => console.log(msg.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.result, null, { timeout: 120000 });
  evidence.first = await page.evaluate(() => window.result);
  console.log(JSON.stringify(evidence.first));
  assert.equal(evidence.first.error, undefined);
  assert.ok(evidence.first.value[0].length >= 2);
  evidence.storage = await page.evaluate(async () => {
    const a = await openNativeStore('contracts');
    const b = await openNativeStore('contracts');
    const original = await a.call('put', 'manifest', new Uint8Array([1]));
    const races = await Promise.all([
      a.call('cas', 'manifest', new Uint8Array([2]), original.version),
      b.call('cas', 'manifest', new Uint8Array([3]), original.version),
    ]);
    let refused = false;
    try { await a.seed([{key:'unexpected',bytes:new Uint8Array([9])}]); } catch { refused = true; }
    const absent = await a.call('get', 'unexpected');
    await a.saveState('publication', { commit: 'prepared-native-git' });
    const publication = await b.loadState('publication');
    const exportedKeys = (await a.export()).map(entry => entry.key);
    a.close(); b.close();
    const reopened = await openNativeStore('contracts');
    const persistedPublication = await reopened.loadState('publication');
    reopened.close();
    return { conflicts: races.filter(r=>r.conflict).length, refused, absent, publication, persistedPublication, exportedKeys };
  });
  assert.equal(evidence.storage.conflicts, 1);
  assert.equal(evidence.storage.refused, true);
  assert.deepEqual(evidence.storage.absent, { missing: true });
  assert.deepEqual(evidence.storage.publication, { commit: 'prepared-native-git' });
  assert.deepEqual(evidence.storage.persistedPublication, evidence.storage.publication);
  assert.deepEqual(evidence.storage.exportedKeys, ['manifest']);
  evidence.storageUpgrade = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open('b9s-native:legacy-contracts', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('blobs');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put({ bytes: new Uint8Array([8]), version: 'original' }, 'manifest');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    const upgraded = await openNativeStore('legacy-contracts');
    try {
      await upgraded.saveState('publication', { commit: 'retained' });
      const blob = await upgraded.call('get', 'manifest');
      return { bytes: [...blob.bytes], version: blob.version, state: await upgraded.loadState('publication') };
    } finally { upgraded.close(); }
  });
  assert.deepEqual(evidence.storageUpgrade, { bytes: [8], version: 'original', state: { commit: 'retained' } });
  await page.reload();
  await page.waitForFunction(() => window.result, null, { timeout: 120000 });
  evidence.reopened = await page.evaluate(() => window.result);
  assert.deepEqual(evidence.reopened, evidence.first);
  await page.goto(`http://127.0.0.1:${server.address().port}/?write=1`);
  await page.waitForFunction(() => window.result, null, { timeout: 120000 });
  evidence.write = await page.evaluate(() => window.result);
  assert.equal(evidence.write.error, undefined);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.result, null, { timeout: 120000 });
  evidence.afterWrite = await page.evaluate(() => window.result);
  assert.equal(evidence.afterWrite.error, undefined);
  assert.ok(evidence.afterWrite.value[0].some(row => row[1] === 'Browser persisted edit'));
  assert.equal(evidence.afterWrite.value[1][0][0], 'browser durable edit');
  await page.goto(`http://127.0.0.1:${server.address().port}/?runtime=1`);
  await page.waitForFunction(() => window.nativeCall || window.result, null, { timeout: 120000 });
  evidence.rpc = await page.evaluate(async () => {
    if (!window.nativeCall) throw Error(JSON.stringify(window.result));
    const exported = JSON.parse(await nativeCall(JSON.stringify({ op: 'export' })));
    const [detail, again] = await Promise.all([
      nativeCall(JSON.stringify({ op: 'issue', id: 'browser-b' })).then(JSON.parse),
      nativeCall(JSON.stringify({ op: 'export' })).then(JSON.parse),
    ]);
    let rejected = false;
    try { await nativeCall(JSON.stringify({ op: 'unsupported' })); } catch { rejected = true; }
    return { exported, detail, again, rejected };
  });
  assert.equal(evidence.rpc.exported.length, 2);
  assert.deepEqual(evidence.rpc.again, evidence.rpc.exported);
  assert.equal(evidence.rpc.detail[0].title, 'Browser persisted edit');
  assert.equal(evidence.rpc.detail[0].comments.length, 2);
  assert.equal(evidence.rpc.detail[0].dependencies[0].depends_on_id, 'browser-a');
  assert.equal(evidence.rpc.rejected, true);
  if (process.env.B9S_NATIVE_WRITES) {
    assert.ok(process.env.B9S_TEST_BD, 'B9S_TEST_BD is required for native mutation readback');
    evidence.mutations = await exerciseNativeMutations(page, '/native.json', {
      source: remote, evidenceRoot: root, bd: resolve(process.env.B9S_TEST_BD),
    });
  }
  let preparedBlobs;
  if (process.env.B9S_NATIVE_SYNC) {
    const prepared = await page.evaluate(async () => {
      const remote = (await (await fetch('/native.json')).json()).map(entry => ({
        key: entry.key, bytes: Uint8Array.from(atob(entry.bytes), c => c.charCodeAt(0)),
      }));
      const result = await runtime.preparePush(remote);
      const repeated = await runtime.preparePush(result.entries);
      return { ...result, repeatedChanged: repeated.changed, repeatedCopiedChunks: repeated.copiedChunks, entries: result.entries.map(({ key, bytes }) => {
        let text = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return { key, bytes: btoa(text) };
      }) };
    });
    assert.ok(prepared.copiedChunks > 0);
    assert.equal(prepared.changed, true);
    assert.equal(prepared.repeatedChanged, false);
    assert.equal(prepared.repeatedCopiedChunks, 0);
    assert.equal(prepared.containsLocalWorkingRoot, false);
    preparedBlobs = prepared.entries;
    evidence.preparedPush = { head: prepared.head, copiedChunks: prepared.copiedChunks, containsLocalWorkingRoot: prepared.containsLocalWorkingRoot };
  }
  if (github) {
    evidence.git = await page.evaluate(async origin => {
      const { GitRemote } = await import('/git-remote.mjs');
      const remote = new GitRemote({
        repository: 'fixture/data', token: () => 'synthetic-git-token',
        fetch: (url, options) => fetch(url.replace('https://api.github.com', origin), options),
      });
      const before = await remote.read();
      const prepared = await runtime.preparePush(before.entries);
      const plan = await remote.prepare(prepared.entries, before.commit, { name: 'Browser tester', email: 'browser@example.invalid' });
      const published = await remote.publish(plan);
      const retry = await remote.publish(plan);
      const after = await remote.read();
      const { openNativeRuntime } = await import('/native-client.mjs');
      const incoming = await openNativeRuntime('incoming', before.entries);
      let merged;
      try {
        merged = await incoming.mergeRemote(after.entries, { name: 'Browser tester', email: 'browser@example.invalid' });
        const imported = await incoming.request({ op: 'issue', id: 'browser-b' });
        const local = await runtime.request({ op: 'issue', id: 'browser-b' });
        if (JSON.stringify(imported) !== JSON.stringify(local)) throw Error('Fetched native issue differs from published issue');
      } finally { incoming.close(); }
      const merges = [];
      for (const [name, id] of [['independent', 'browser-a'], ['conflicting', 'browser-b']]) {
        const client = await openNativeRuntime(name, before.entries);
        try {
          const old = (await client.request({ op: 'issue', id }))[0];
          await client.request({ op: 'write', command: {
            op: 'update', key: `merge-${name}-001`, ids: [id], expected: { [id]: old.revision },
            actor: 'Browser tester', email: 'browser@example.invalid', fields: { title: `${name} local title` },
          } });
          const beforeMerge = await client.request({ op: 'export' });
          let error = '';
          try { await client.mergeRemote(after.entries, { name: 'Browser tester', email: 'browser@example.invalid' }); }
          catch (failure) { error = failure.message; }
          const retained = (await client.request({ op: 'issue', id }))[0];
          if (retained.title !== `${name} local title`) throw Error('Merge overwrote the local edit');
          if (name === 'independent') {
            if (error) throw Error(`Independent merge failed: ${error}`);
            const imported = (await client.request({ op: 'issue', id: 'browser-b' }))[0];
            if (imported.title !== 'Browser persisted edit') throw Error('Independent merge lost the remote edit');
          } else {
            if (!/conflict/i.test(error)) throw Error(`Expected a merge conflict: ${error}`);
            if (JSON.stringify(await client.request({ op: 'export' })) !== JSON.stringify(beforeMerge)) {
              throw Error('Rejected merge changed local issue data');
            }
            await client.request({ op: 'write', command: {
              op: 'comment', key: 'after-conflict-001', ids: [id], expected: { [id]: retained.revision },
              actor: 'Browser tester', email: 'browser@example.invalid', text: 'Local work survives rejected merge',
            } });
          }
          merges.push({ name, error, retainedTitle: retained.title });
        } finally { client.close(); }
      }
      return { base: before.commit, published, retry, current: after.commit, head: prepared.head,
        containsLocalWorkingRoot: prepared.containsLocalWorkingRoot, merged, merges };
    }, github.origin);
    assert.equal(evidence.git.published, evidence.git.retry);
    assert.equal(evidence.git.published, evidence.git.current);
    assert.equal(evidence.git.containsLocalWorkingRoot, false);
    assert.ok(github.requests.some(request => request.method === 'OPTIONS'));
    assert.ok(github.requests.filter(request => ['POST', 'PATCH'].includes(request.method)).every(request => request.authorized));
    evidence.git.requests = github.requests;
  }
  assert.equal(await page.evaluate(async () => {
    runtime.close();
    try { await runtime.request({op:'export'}); return false; } catch { return true; }
  }), true);
  const blobs = preparedBlobs || await page.evaluate(async () => {
    const store = await openNativeStore('fixture');
    try {
      return (await store.export()).map(({ key, bytes }) => {
        let text = '';
        for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { key, bytes: btoa(text) };
      });
    } finally { store.close(); }
  });
  const roundtrip = mkdtempSync(`${root}/roundtrip-${engine}-`);
  const env = nativeEnv();
  const runGit = (args, input) => execFileSync('git', args, { input, env, encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20 }).trim();
  runGit(['clone', '--mirror', github ? github.remote : remote, `${roundtrip}/remote.git`]);
  const args = [`--git-dir=${roundtrip}/remote.git`];
  if (!github) {
  const tree = runGit([...args, 'mktree'], blobs.map(blob => {
    assert.match(blob.key, /^[a-zA-Z0-9._-]+$/);
    const hash = runGit([...args, 'hash-object', '-w', '--stdin'], Buffer.from(blob.bytes, 'base64'));
    return `100644 blob ${hash}\t${blob.key}\n`;
  }).join(''));
  const commit = runGit([...args, 'commit-tree', tree, '-p', evidence.sourceRef, '-m', 'Browser native Dolt storage roundtrip']);
  runGit([...args, 'update-ref', 'refs/dolt/data', commit, evidence.sourceRef]);
  }
  assert.ok(process.env.B9S_TEST_BD, 'B9S_TEST_BD is required for native readback');
  const native = synchronize({ remote: `${roundtrip}/remote.git`, bd: resolve(process.env.B9S_TEST_BD), work: `${roundtrip}/native-readback` });
  const edited = native.snapshot.issues.find(issue => issue.id === 'browser-b');
  assert.equal(edited.title, 'Browser persisted edit');
  assert.equal(edited.comment_count, 2);
  assert.equal(edited.status, 'open');
  assert.deepEqual(edited.blocked_by, ['browser-a']);
  evidence.nativeReadback = { revision: native.revision, issues: native.snapshot.issues.map(({ id, title, comment_count, blocked_by }) => ({ id, title, comment_count, blocked_by })) };
  evidence.passed = true;
} finally {
  writeFileSync(`${root}/results/persistent-${engine}.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
  server.close();
  if (github) await github.close();
}
