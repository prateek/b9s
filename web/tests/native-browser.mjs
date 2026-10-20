import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { gitAPIFixture } from './git-api-fixture.mjs';
import { synchronize, nativeEnv } from './native-readback.mjs';
import { exerciseNativeConflicts } from './native-conflicts.mjs';
import { exerciseNativeBranches } from './native-branches.mjs';
import { exerciseResolutionEdges, faultWorker } from './native-resolution.mjs';
import { exerciseNativeReadiness } from './native-readiness.mjs';
import { exerciseNativeProjects, exerciseNativeFreshness, prepareProjectTests } from './native-projects.mjs';
import { exerciseNativeMutations, exerciseNativeLifecycleUI } from './native-mutations.mjs';

const runtime = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-native-rpc');
const evidenceRoot = resolve(process.env.B9S_NATIVE_EVIDENCE || runtime);
const remote = resolve(process.argv[2]);
const root = `${evidenceRoot}/site`;
const output = `${evidenceRoot}/screenshots`;
mkdirSync(output, { recursive: true });
mkdirSync(`${evidenceRoot}/results`, { recursive: true });
execFileSync('node', ['web/build.mjs', '--native', '--runtime', runtime, '--out', root], { stdio: 'inherit' });
await prepareProjectTests(root);
const git = (...args) => execFileSync('git', [`--git-dir=${remote}`, ...args], { timeout: 30000, maxBuffer: 64 << 20 });
const entries = git('ls-tree', '-r', 'refs/dolt/data').toString().trim().split('\n').map(line => {
  const [metadata, key] = line.split('\t');
  return { key, bytes: git('cat-file', 'blob', metadata.split(' ')[2]).toString('base64') };
});
const configuration = {
  schema: 1, projects: [{ key: 'synthetic', name: 'Native browser fixture', bootstrap: './native-fixture.json' }],
  identity: { name: 'Browser tester', email: 'browser@example.invalid' },
};
if (process.env.B9S_NATIVE_GIT) configuration.projects = [{
  key: 'synthetic', name: 'Native browser fixture', source: { repository: 'fixture/data' },
}];
configuration.projects.push(
  { key: 'secondary', name: 'Secondary native fixture', bootstrap: './native-fixture.json' },
  { key: 'unavailable', name: 'Unavailable fixture', bootstrap: './missing-fixture.json' },
);
writeFileSync(`${root}/native-config.json`, JSON.stringify(configuration));
writeFileSync(`${root}/native-fixture.json`, JSON.stringify(entries));
writeFileSync(`${root}/native-fault-worker.mjs`, faultWorker);
let encodedRuntime = false;
let missingFixtureAvailable = false;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith('/b9s/')) { res.writeHead(404).end(); return; }
  const relative = path === '/b9s/missing-fixture.json' && missingFixtureAvailable ? 'native-fixture.json' : path.slice(5);
  const file = resolve(root, relative || 'index.html');
  if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
  try {
    if (encodedRuntime && file.endsWith('/native.wasm.gz')) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const originPort = server.address().port;
const evidence = [];
try {
  for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
    encodedRuntime = engine === 'webkit';
    missingFixtureAvailable = false;
    const browser = await browserType.launch({ headless: true });
    const privateReads = engine === 'webkit';
    const github = process.env.B9S_NATIVE_GIT ? await gitAPIFixture(remote, evidenceRoot, { privateReads }) : undefined;
    const result = { engine, passed: false };
    evidence.push(result);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.addInitScript(() => {
        window.resolutionAttempts = 0;
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(message, ...args) {
          if (message.op === 'request' && message.payload.op === 'write') {
            window.lastNativeRequest = { project: 'synthetic', command: message.payload.command };
          }
          if (message.op === 'resolve-merge') {
            window.resolutionAttempts++;
            if (window.loseResolutionAcknowledgement) {
              window.loseResolutionAcknowledgement = false;
              const receive = this.onmessage;
              this.onmessage = event => {
                if (event.data.id === message.id && !event.data.error) {
                  this.terminate();
                  this.onerror({ message: 'Synthetic worker disconnect after durable resolution' });
                } else receive(event);
              };
            }
          }
          return post.call(this, message, ...args);
        };
      });
      if (github) await page.addInitScript(origin => {
        const fetcher = window.fetch.bind(window);
        window.fetch = (url, options) => fetcher(
          typeof url === 'string' ? url.replace('https://api.github.com', origin) : url, options,
        );
      }, github.origin);
      await page.goto(`http://127.0.0.1:${originPort}/b9s/`);
      if (github && privateReads) {
        await page.locator('input[name="token"]').fill('synthetic-git-token');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
      }
      await page.waitForFunction(() => document.querySelector('#boot').hidden || document.querySelector('#bootRetry'), null, { timeout: 150000 });
      await expect(page.locator('#boot')).toBeHidden();
      if (!process.env.B9S_NATIVE_CASE || process.env.B9S_NATIVE_CASE === 'projects') {
        result.projects = await exerciseNativeProjects(context, `http://127.0.0.1:${originPort}`);
        const projectButton = page.getByRole('button', { name: 'Switch project', exact: true });
        await projectButton.click();
        await page.locator('[data-sa="proj"][data-val="secondary"]').click();
        await expect(projectButton).toContainText('Secondary native fixture', { timeout: 150000 });
        await expect(page.locator('#treeRows .row[data-id="browser-b"]')).toBeVisible();
        await projectButton.click();
        await page.locator('[data-sa="proj"][data-val="unavailable"]').click();
        await expect(page.locator('#toast')).toContainText('Could not open project:');
        await expect(projectButton).toContainText('Secondary native fixture');
        await expect(page.locator('#treeRows .row[data-id="browser-b"]')).toBeVisible();
        await page.screenshot({ path: `${output}/${engine}-project-failure.png` });
        await projectButton.click();
        await page.locator('[data-sa="proj"][data-val="synthetic"]').click();
        await expect(projectButton).toContainText('Native browser fixture', { timeout: 150000 });
        await expect(page.locator('#treeRows .row[data-id="browser-b"]')).toBeVisible();
        missingFixtureAvailable = true;
        await projectButton.click();
        await page.locator('[data-sa="proj"][data-val="*"]').click();
        await expect(projectButton).toContainText('all', { timeout: 150000 });
        await expect(projectButton.locator('.ro')).toHaveText('ro');
        await expect(page.locator('#treeRows .row')).toHaveCount(6);
        await expect(page.locator('#treeRows .row[data-id$="::browser-b"]')).toHaveCount(3);
        await page.screenshot({ path: `${output}/${engine}-all-projects.png` });
        await projectButton.click();
        await page.locator('[data-sa="proj"][data-val="synthetic"]').click();
        await expect(projectButton).toContainText('Native browser fixture', { timeout: 150000 });
        await expect(page.locator('#treeRows .row[data-id="browser-b"]')).toBeVisible();
        result.projects.mobileSwitchAndFailure = true;
        result.projects.mobileCombinedView = true;
        assert.deepEqual(errors, []);
      }
      if (process.env.B9S_NATIVE_CASE === 'projects') {
        Object.assign(result, { passed: true, scope: 'projects' });
        continue;
      }
      if (!process.env.B9S_NATIVE_CASE || process.env.B9S_NATIVE_CASE === 'freshness') {
        result.freshness = await exerciseNativeFreshness(context, `http://127.0.0.1:${originPort}`);
      }
      if (process.env.B9S_NATIVE_CASE === 'freshness') {
        Object.assign(result, { passed: true, scope: 'freshness' });
        continue;
      }
      if (!process.env.B9S_NATIVE_CASE || process.env.B9S_NATIVE_CASE === 'mutations') {
        result.mutations = await exerciseNativeMutations(page, './native-fixture.json', process.env.B9S_TEST_BD
          ? { source: remote, evidenceRoot, bd: process.env.B9S_TEST_BD } : undefined);
        result.lifecycleUI = await exerciseNativeLifecycleUI(page, `${output}/${engine}-native-lifecycle.png`);
      }
      if (process.env.B9S_NATIVE_CASE === 'mutations') {
        assert.deepEqual(errors, []);
        Object.assign(result, { passed: true, scope: 'mutations' });
        continue;
      }
      if (process.env.B9S_TEST_BD && process.env.B9S_NATIVE_CASE !== 'resolution') {
        result.readiness = await exerciseNativeReadiness(page, evidenceRoot, process.env.B9S_TEST_BD);
      }
      if (process.env.B9S_NATIVE_CASE === 'readiness') {
        if (!result.readiness) throw Error('The readiness test requires B9S_TEST_BD');
        assert.deepEqual(errors, []);
        Object.assign(result, { passed: true, scope: 'readiness' });
        continue;
      }
      result.resolutionEdges = await exerciseResolutionEdges(page);
      if (process.env.B9S_NATIVE_CASE === 'resolution') {
        assert.deepEqual(errors, []);
        Object.assign(result, { passed: true, scope: 'resolution' });
        continue;
      }
      const branchGuard = await page.evaluate(async () => {
        const { openNativeRuntime } = await import('./native-client.mjs');
        const blobs = await (await fetch('./native-fixture.json')).json();
        const entries = blobs.map(({ key, bytes }) => ({ key, bytes: Uint8Array.from(atob(bytes), character => character.charCodeAt(0)) }));
        try {
          const invalid = await openNativeRuntime('missing-branch-test', entries, 'branch-that-does-not-exist');
          invalid.close();
          return '';
        } catch (error) { return error.message; }
      });
      assert.match(branchGuard, /branch|not found/i);
      result.branches = await exerciseNativeBranches(page);
      result.conflicts = await exerciseNativeConflicts(page);
      result.branchConflicts = await exerciseNativeConflicts(page, 'browser-review');
      await page.locator('#bar [data-view="memory"]').click();
      await expect(page.locator('#vMemory')).toContainText('not a Memory graph workspace');
      await page.locator('#bar [data-view="tree"]').click();
      const row = page.locator('#treeRows .row[data-id="browser-b"]');
      await expect(row).toBeVisible();
      await page.screenshot({ path: `${output}/${engine}-native-tree.png` });
      await page.locator('#bar [data-view="board"]').click();
      await expect(page.locator('#vBoard')).toContainText('Native browser task');
      await page.screenshot({ path: `${output}/${engine}-native-board.png` });
      await page.locator('#bar [data-view="search"]').click();
      await page.locator('#sIn').fill('type:task');
      await expect(page.locator('#sList')).toContainText('Native browser task');
      await page.locator('#sIn').fill('type:task type:epic !status:closed');
      await expect(page.locator('#sList')).toContainText('2 matches');
      await page.locator('#sIn').fill('branch:browser-b');
      await expect(page.locator('#sList')).toContainText('1 match');
      await expect(page.locator('#sList')).toContainText('Native browser task');
      await page.locator('#sIn').fill('title:btsk project:browser');
      await expect(page.locator('#sList')).toContainText('Native browser task');
      await page.locator('#bar [data-view="tree"]').click();
      await row.click();
      await expect(page.locator('.detail')).toContainText('Native release fixture comment');
      await page.locator('.detail .dacts [data-act="comment"]').click();
      await page.locator('#fComment').fill('Written from the native b9s UI');
      await page.locator('[data-sa="docomment"]').click();
      await expect(page.locator('.detail')).toContainText('Written from the native b9s UI');
      const successfulRequest = await page.evaluate(() => window.lastNativeRequest);
      assert.ok(successfulRequest);
      const writerPage = await context.newPage();
      writerPage.on('pageerror', error => errors.push(error.message));
      try {
        await writerPage.goto(`http://127.0.0.1:${originPort}/b9s/`);
        await expect(writerPage.locator('#boot')).toBeHidden({ timeout: 150000 });
        await writerPage.locator('#treeRows .row[data-id="browser-b"]').click();
        await writerPage.locator('.detail .dacts [data-act="comment"]').click();
        await writerPage.locator('#fComment').fill('Written in another browser tab');
        await writerPage.locator('[data-sa="docomment"]').click();
        await expect(writerPage.locator('.detail')).toContainText('Written in another browser tab');
        await expect(page.locator('.detail')).toContainText('Written in another browser tab', { timeout: 15000 });
        await page.screenshot({ path: `${output}/${engine}-native-cross-tab.png` });
        result.mobileCrossTab = true;
      } finally { await writerPage.close(); }
      await page.getByRole('button', { name: 'Local changes', exact: true }).click();
      await expect(page.locator('#native-feedback')).toContainText('Succeeded locally');
      await expect(page.locator('#native-offline-feedback')).toBeAttached();
      await expect(page.locator('#native-offline-feedback')).toContainText('Ready for offline use', { timeout: 150000 });
      result.cache = await page.evaluate(async () => {
        const urls = [];
        for (const key of await caches.keys()) {
          if (!key.startsWith(`b9s-native:${location.origin}${location.pathname}:`)) continue;
          const cache = await caches.open(key);
          urls.push(...(await cache.keys()).map(request => request.url));
        }
        return { controlled: !!navigator.serviceWorker.controller, urls };
      });
      assert.equal(result.cache.controlled, true);
      assert.ok(result.cache.urls.some(url => url.endsWith('/native.wasm.gz')));
      assert.ok(result.cache.urls.some(url => url.endsWith('/native-config.json')));
      assert.equal(result.cache.urls.some(url => url.includes('native-fixture') || new URL(url).origin !== `http://127.0.0.1:${originPort}`), false);
      await page.locator('.sync-dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.screenshot({ path: `${output}/${engine}-native-detail.png` });
      await page.locator('.detail .dacts [data-act="status"]').click();
      await page.locator('[data-sa="setstatus"][data-val="closed"]').click();
      await page.locator('#fCloseComment').fill('This blocked close must roll back');
      await page.locator('[data-sa="doclose"]').click();
      await expect(page.locator('#toast')).toContainText('Failed:');
      await expect(page.locator('.detail')).not.toContainText('This blocked close must roll back');
      await page.getByRole('button', { name: 'Local changes', exact: true }).click();
      await expect(page.locator('#native-feedback')).toContainText('Failed without applying changes');
      await expect(page.locator('#native-retry')).toBeDisabled();
      await page.screenshot({ path: `${output}/${engine}-native-rejected.png` });
      await page.locator('.sync-dialog').getByRole('button', { name: 'Close', exact: true }).click();
      if (engine === 'webkit') await new Promise(resolve => server.close(resolve));
      else await context.setOffline(true);
      const remoteRequests = github?.requests.length;
      await page.reload();
      await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
      await expect(page.locator('#app')).toContainText('Offline');
      await expect(page.locator('.detail')).toContainText('Written from the native b9s UI');
      await page.locator('.detail .dacts [data-act="comment"]').click();
      await page.locator('#fComment').fill('Written while offline');
      await page.locator('[data-sa="docomment"]').click();
      await expect(page.locator('.detail')).toContainText('Written while offline');
      await page.screenshot({ path: `${output}/${engine}-native-offline.png` });
      assert.equal(github?.requests.length, remoteRequests);
      if (engine === 'webkit') await new Promise(resolve => server.listen(originPort, '127.0.0.1', resolve));
      else await context.setOffline(false);
      await page.route('**/native-fixture.json', route => route.abort());
      await page.reload();
      await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
      await expect(page.locator('.detail')).toContainText('Native release fixture comment');
      await expect(page.locator('.detail')).toContainText('Written from the native b9s UI');
      await page.evaluate(async request => {
        const databases = await indexedDB.databases();
        const name = databases.find(db => db.name.startsWith(`b9s-native:${location.origin}${location.pathname}:synthetic`)).name;
        await new Promise((resolve, reject) => {
          const opening = indexedDB.open(name, 2);
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result;
            const tx = db.transaction('state', 'readwrite');
            tx.objectStore('state').put(request, 'command');
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onabort = () => { db.close(); reject(tx.error); };
          };
        });
      }, successfulRequest);
      await page.reload();
      await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
      await page.getByRole('button', { name: 'Local changes', exact: true }).click();
      await expect(page.locator('#native-feedback')).toContainText('Unresolved request');
      await page.locator('#native-retry').click();
      await expect(page.locator('#native-feedback')).toContainText('Succeeded locally', { timeout: 150000 });
      await page.locator('.sync-dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.locator('.detail').getByText('Written from the native b9s UI', { exact: true })).toHaveCount(1);
      if (github) {
        github.loseNextPublicationAcknowledgement();
        await page.getByRole('button', { name: 'Local changes', exact: true }).click();
        await page.getByRole('button', { name: 'Sync with GitHub', exact: true }).click();
        await page.locator('input[name="token"]').fill('synthetic-git-token');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.locator('#native-sync-feedback')).toContainText('could not be confirmed', { timeout: 150000 });
        const publications = github.requests.filter(request => request.method === 'PATCH').length;
        github.restore();
        await page.reload();
        await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
        await page.getByRole('button', { name: 'Local changes', exact: true }).click();
        await expect(page.locator('#native-sync-feedback')).toContainText('Unresolved publication');
        await page.getByRole('button', { name: 'Sync with GitHub', exact: true }).click();
        await page.locator('input[name="token"]').fill('synthetic-git-token');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.locator('#native-sync-feedback')).toContainText('Published the prepared changes', { timeout: 150000 });
        assert.equal(github.requests.filter(request => request.method === 'PATCH').length, publications);
        await page.screenshot({ path: `${output}/${engine}-native-synchronized.png` });
        const writes = github.requests.filter(request => request.method === 'PATCH').length;
        await page.getByRole('button', { name: 'Sync with GitHub', exact: true }).click();
        await expect(page.locator('#native-sync-feedback')).toContainText('local history matches', { timeout: 150000 });
        assert.equal(github.requests.filter(request => request.method === 'PATCH').length, writes);
        const work = mkdtempSync(`${evidenceRoot}/ui-readback-${engine}-`);
        assert.ok(process.env.B9S_TEST_BD, 'B9S_TEST_BD is required for Git UI readback');
        const native = synchronize({ remote: github.remote, bd: process.env.B9S_TEST_BD, work: `${work}/native` });
        const task = native.snapshot.issues.find(issue => issue.id === 'browser-b');
        assert.equal(task.comments.filter(comment => comment.text === 'Written from the native b9s UI').length, 1);
        assert.equal(task.comments.filter(comment => comment.text === 'Written while offline').length, 1);
        const memory = execFileSync(process.env.B9S_TEST_BD, ['recall', 'browser-fixture'], {
          cwd: `${work}/native/native`, encoding: 'utf8', timeout: 30000,
          env: nativeEnv({ BEADS_DIR: `${work}/native/native/.beads`, HOME: `${work}/native/home`, XDG_CONFIG_HOME: `${work}/native/config` }),
        });
        assert.ok(memory.includes('Synthetic native memory survives browser synchronization.'));
        await page.locator('.sync-dialog').getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('.detail .dacts [data-act="edit"]').click();
        await page.locator('#fTitle').fill('Local competing title');
        await page.locator('[data-sa="save"]').click();
        await expect(page.locator('.detail')).toContainText('Local competing title');
        synchronize({
          remote: github.remote, bd: process.env.B9S_TEST_BD, work: `${work}/competing`,
          command: { op: 'update', key: 'ui-remote-conflict', base: native.revision, ids: ['browser-b'], fields: { title: 'Remote competing title' } },
        });
        const uploads = github.requests.filter(request => ['POST', 'PATCH'].includes(request.method)).length;
        await page.getByRole('button', { name: 'Local changes', exact: true }).click();
        await page.getByRole('button', { name: 'Sync with GitHub', exact: true }).click();
        await expect(page.locator('#native-conflicts')).toContainText('Conflicting changes', { timeout: 150000 });
        await page.locator('#native-conflicts summary').filter({ hasText: 'browser-b' }).click();
        await expect(page.locator('#native-conflicts')).toContainText('Local: Local competing title');
        await expect(page.locator('#native-conflicts')).toContainText('Remote: Remote competing title');
        assert.equal(github.requests.filter(request => ['POST', 'PATCH'].includes(request.method)).length, uploads);
        await page.screenshot({ path: `${output}/${engine}-native-conflicts.png` });
        result.conflictReviewWithoutPublication = true;
        await expect(page.locator('#native-resolve')).toBeDisabled();
        await page.getByLabel('Version for browser-b', { exact: true }).selectOption('theirs');
        await page.evaluate(() => { window.loseResolutionAcknowledgement = true; });
        await page.locator('#native-resolve').click();
        await expect(page.locator('#native-sync-feedback')).toContainText('outcome unresolved', { timeout: 150000 });
        await expect(page.locator('#native-resolve')).toContainText('Retry reviewed resolution');
        await page.reload();
        await expect(page.locator('#boot')).toBeHidden({ timeout: 150000 });
        await page.getByRole('button', { name: 'Local changes', exact: true }).click();
        await expect(page.locator('#native-conflicts')).toContainText('unresolved outcome');
        await page.locator('#native-resolve').click();
        await expect(page.locator('#native-sync-feedback')).toContainText('Resolved locally', { timeout: 150000 });
        assert.equal(await page.evaluate(() => window.resolutionAttempts), 0);
        await expect(page.locator('#native-conflicts')).toBeEmpty();
        assert.equal(github.requests.filter(request => ['POST', 'PATCH'].includes(request.method)).length, uploads);
        await page.getByRole('button', { name: 'Sync with GitHub', exact: true }).click();
        await page.locator('input[name="token"]').fill('synthetic-git-token');
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.locator('#native-sync-feedback')).toContainText('Published the prepared changes', { timeout: 150000 });
        const resolvedNative = synchronize({ remote: github.remote, bd: process.env.B9S_TEST_BD, work: `${work}/resolved` });
        const resolvedTask = resolvedNative.snapshot.issues.find(issue => issue.id === 'browser-b');
        assert.equal(resolvedTask.title, 'Remote competing title');
        assert.equal(resolvedTask.comments.filter(comment => comment.text === 'Written while offline').length, 1);
        await page.screenshot({ path: `${output}/${engine}-native-resolved.png` });
        result.resolutionPublishedAndReadByNative = true;
        await page.getByRole('button', { name: 'Forget token', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Forget token', exact: true })).toBeHidden();
        assert.ok(github.requests.filter(request => ['POST', 'PATCH'].includes(request.method)).every(request => request.authorized));
        assert.equal(requests.some(url => url.includes('synthetic-git-token')), false);
      }
      assert.equal(requests.some(url => url.includes('/api/')), false);
      assert.equal(requests.some(url => ![`http://127.0.0.1:${originPort}`, github?.origin].includes(new URL(url).origin)), false);
      assert.deepEqual(errors, []);
      Object.assign(result, { passed: true, offlineMethod: engine === 'webkit' ? 'origin server stopped' : 'browser offline emulation', coldOfflineReloadAndWrite: true, nativeStorageReload: true, nativeCommentWrite: true, rejectedMissingBranch: true, blockedCloseRollback: true, recoveredRequestWithoutDuplicate: true, gitSyncAndNativeReadback: !!github, recoveredPublicationAfterReload: !!github, mobileViews: ['tree', 'board', 'search', 'detail'], relativeAssets: true, applicationBackendRequests: 0 });
    } catch (error) {
      result.error = String(error);
      throw error;
    } finally {
      writeFileSync(`${evidenceRoot}/results/native-ui.json`, JSON.stringify(evidence, null, 2));
      await browser.close();
      if (github) await github.close();
    }
  }
  writeFileSync(`${evidenceRoot}/results/native-ui.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { if (server.listening) server.close(); }
