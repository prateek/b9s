import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

export async function prepareProjectTests(root) {
  await build({
    entryPoints: ['web/src/native-api.ts'], bundle: true, format: 'esm',
    outfile: `${root}/native-api-test.mjs`, external: ['./native-client.mjs'],
  });
  writeFileSync(`${root}/native-projects.html`, '<!doctype html><title>Native project adapter test</title><div id="banner"></div><script type="module">import * as api from "./native-api-test.mjs"; window.nativeAPI = api;</script>');
}

async function projectPage(context, origin) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const fetcher = window.fetch.bind(window);
    window.fetch = (url, options) => url === 'native-config.json'
      ? Promise.resolve(new Response(JSON.stringify({
        schema: 1, identity: { name: 'Project tester', email: 'projects@example.invalid' },
        projects: ['alpha', 'beta', 'gamma'].map(key => ({ key, name: key, bootstrap: './native-fixture.json' })),
      }), { headers: { 'Content-Type': 'application/json' } }))
      : fetcher(url, options);
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.op === 'initialize') {
        this.projectName = message.payload.name;
        window.projectInitializations = (window.projectInitializations || 0) + 1;
        (window.projectWorkers ||= []).push(this);
      }
      if (window.projectHoldKey && this.projectName?.endsWith(`:${window.projectHoldKey}`) &&
          (window.projectHoldOperation ? message.op === window.projectHoldOperation
            : message.op === 'request' && message.payload.op === 'export')) {
        window.projectHoldKey = null;
        window.projectHoldOperation = null;
        const receive = this.onmessage;
        this.onmessage = event => {
          if (event.data.id === message.id) {
            window.releaseProjectReply = () => receive(event);
            window.projectHoldReady();
          } else receive(event);
        };
      }
      const fault = window.projectFault;
      if (fault && this.projectName?.endsWith(`:${fault.project}`) &&
          (fault.operation === message.op || (fault.operation === 'export' && message.op === 'request' && message.payload.op === 'export'))) {
        if (!fault.repeat) window.projectFault = null;
        queueMicrotask(() => this.onmessage({ data: { id: message.id, error: `Synthetic project ${fault.operation} failure` } }));
        return;
      }
      return post.call(this, message, ...args);
    };
  });
  await page.goto(`${origin}/b9s/native-projects.html`);
  await page.waitForFunction(() => !!window.nativeAPI, null, { timeout: 30000 });
  return page;
}

export async function exerciseNativeProjects(context, origin) {
  const page = await projectPage(context, origin);
  try {
    const result = await page.evaluate(async () => {
      const api = window.nativeAPI;
      await api.session();
      await api.snapshot();
      const changed = await api.write({ op: 'update', ids: ['browser-b'], fields: { title: 'Alpha before switch' } });
      await api.snapshot();
      window.projectFault = { project: 'beta', operation: 'load-state' };
      let journalFailure = '';
      try { await api.openProject('beta'); } catch (error) { journalFailure = error.message; }
      const afterJournalFailure = await api.snapshot();
      const continued = await api.write({ op: 'update', ids: ['browser-b'], fields: { title: 'Alpha after failed switch' } });
      await api.snapshot();
      await api.openProject('beta');
      const beta = await api.snapshot();
      window.projectFault = { project: 'gamma', operation: 'export' };
      let exportFailure = '';
      try { await api.openProject('gamma'); } catch (error) { exportFailure = error.message; }
      const afterExportFailure = await api.snapshot();
      await api.openProject('alpha');
      const alpha = await api.snapshot();
      const hold = (key, operation) => {
        window.projectHoldKey = key;
        window.projectHoldOperation = operation;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Project snapshot hold timed out')), 30000);
          window.projectHoldReady = () => { clearTimeout(timer); resolve(); };
        });
      };
      let held = hold('gamma');
      const switching = api.openProject('gamma');
      await held;
      const blockedWrite = await api.write({ op: 'update', ids: ['browser-b'], fields: { title: 'Must not be written during switching' } });
      let blockedSwitch = '';
      try { await api.openProject('beta'); } catch (error) { blockedSwitch = error.message; }
      window.releaseProjectReply();
      await switching;
      const gamma = await api.snapshot();
      held = hold('gamma');
      const oldRead = api.snapshot().catch(error => ({ error: error.message }));
      await held;
      await api.openProject('alpha');
      const late = await oldRead;
      window.releaseProjectReply();
      window.projectFault = { project: 'beta', operation: 'export' };
      let combinedFailure = '';
      try { await api.openProject('*'); } catch (error) { combinedFailure = error.message; }
      const retained = await api.snapshot();
      const initializedBefore = window.projectInitializations;
      await api.openProject('*');
      const combined = await api.snapshot();
      const repeatedCombined = await api.snapshot();
      const aggregateInitializations = window.projectInitializations - initializedBefore;
      const combinedList = await api.projects();
      const combinedWrite = await api.write({ op: 'update', ids: [combined.issues[0].id], fields: { title: 'Must remain read only' } });
      const selected = await api.query('project:alpha');
      const detail = await api.issue(selected.ids.find(id => combined.issues.find(i => i.id === id)?.title === 'Alpha after failed switch'));
      held = hold('alpha');
      const obsoleteCombined = api.reload().then(() => api.snapshot());
      await held;
      const releaseCombined = window.releaseProjectReply;
      await api.openProject('alpha');
      const afterCombined = await api.snapshot();
      await api.write({ op: 'update', ids: ['browser-b'], fields: { title: 'Alpha after combined read' } });
      await api.openProject('*');
      releaseCombined();
      const lateCombined = await obsoleteCombined;
      await api.openProject('alpha');
      held = hold('alpha', 'load-state');
      const preparingWrite = api.write({ op: 'update', ids: ['browser-b'], fields: { title: 'Alpha prepared write' } }).catch(error => ({ error: error.message }));
      await held;
      let preparingSwitch = '';
      try { await api.openProject('beta'); } catch (error) { preparingSwitch = error.message; }
      await api.snapshot();
      window.releaseProjectReply();
      const preparedWrite = await preparingWrite;
      await api.openProject('alpha');
      const afterPreparedWrite = await api.snapshot();
      return { changed, continued, journalFailure, exportFailure, afterJournalFailure, afterExportFailure, alpha, beta, gamma, blockedWrite, blockedSwitch, late,
        combinedFailure, retained, combined, combinedWrite, selected, detail, afterCombined, lateCombined,
        repeatedCombined, aggregateInitializations, combinedList, preparingSwitch, preparedWrite, afterPreparedWrite };
    });
    assert.equal(result.changed.ok, true);
    assert.match(result.journalFailure, /Synthetic project load-state failure/);
    assert.equal(result.afterJournalFailure.project.key, 'alpha');
    assert.equal(result.afterJournalFailure.issues.find(issue => issue.id === 'browser-b').title, 'Alpha before switch');
    assert.equal(result.continued.ok, true);
    assert.equal(result.beta.issues.find(issue => issue.id === 'browser-b').title, 'Native browser task');
    assert.match(result.exportFailure, /Synthetic project export failure/);
    assert.equal(result.afterExportFailure.project.key, 'beta');
    assert.equal(result.alpha.issues.find(issue => issue.id === 'browser-b').title, 'Alpha after failed switch');
    assert.equal(result.blockedWrite.ok, false);
    assert.match(result.blockedWrite.error, /switching/);
    assert.match(result.blockedSwitch, /pending operation/);
    assert.equal(result.gamma.issues.find(issue => issue.id === 'browser-b').title, 'Native browser task');
    assert.equal(result.late.project.key, 'alpha');
    assert.equal(result.late.issues.find(issue => issue.id === 'browser-b').title, 'Alpha after failed switch');
    assert.match(result.combinedFailure, /beta.*Synthetic project export failure/);
    assert.equal(result.retained.project.key, 'alpha');
    assert.equal(result.combined.project.all, true);
    assert.equal(result.combined.project.read_only, true);
    assert.equal(result.aggregateInitializations, 3, 'Opening and reading the combined view initializes each database only once');
    assert.equal(result.repeatedCombined.version, result.combined.version);
    assert.deepEqual(result.combinedList.projects.map(p => [p.key, p.open, p.ready, p.blocked, p.reach]),
      ['alpha', 'beta', 'gamma'].map(key => [key, 2, 1, 1, 'local']));
    assert.equal(result.combined.issues.length, 6);
    assert.equal(new Set(result.combined.issues.map(i => i.id)).size, 6);
    for (const task of result.combined.issues.filter(i => i.type === 'task')) {
      assert.equal(task.blocked_by.length, 1);
      assert.equal(result.combined.issues.find(i => i.id === task.blocked_by[0]).project, task.project);
    }
    assert.equal(result.selected.ids.length, 2);
    assert.equal(result.detail.title, 'Alpha after failed switch');
    assert.equal(result.combinedWrite.ok, false);
    assert.match(result.combinedWrite.error, /read.only/i);
    assert.equal(result.afterCombined.issues.find(i => i.id === 'browser-b').title, 'Alpha after failed switch');
    assert.equal(result.lateCombined.issues.find(i => i.project === 'alpha' && i.type === 'task').title, 'Alpha after combined read');
    assert.match(result.preparingSwitch, /pending operation/);
    assert.equal(result.preparedWrite.ok, true);
    assert.equal(result.afterPreparedWrite.issues.find(i => i.id === 'browser-b').title, 'Alpha prepared write');
    return { journalFailureRetainedProject: true, exportFailureRetainedProject: true, writesStayedInProject: true, switchingSerialized: true, lateReadDiscarded: true,
      combinedProjects: true, combinedFailureRetainedProject: true, combinedReadOnly: true };
  } finally { await page.close(); }
}

export async function exerciseNativeFreshness(context, origin) {
  const observer = await projectPage(context, origin);
  const writer = await projectPage(context, origin);
  try {
    await observer.evaluate(async () => {
      await nativeAPI.session();
      window.observedTitle = '';
      window.freshnessErrors = [];
      window.freshnessStream = nativeAPI.live({
        onState(state) { window.freshnessState = state; },
        async onEvent() {
          try {
            const snapshot = await nativeAPI.snapshot();
            window.observedTitle = snapshot.issues.find(i => i.title.startsWith('Cross-tab'))?.title;
          } catch (error) { window.freshnessErrors.push(error.message); }
        },
      });
    });
    await writer.evaluate(() => nativeAPI.session());
    const change = title => writer.evaluate(async title => {
      await nativeAPI.snapshot();
      return nativeAPI.write({ op: 'update', ids: ['browser-b'], fields: { title } });
    }, title);
    assert.equal((await change('Cross-tab single project')).ok, true);
    await observer.waitForFunction(() => window.observedTitle === 'Cross-tab single project', null, { timeout: 15000 });
    await observer.evaluate(() => { window.projectFault = { project: 'alpha', operation: 'export', repeat: true }; });
    assert.equal((await change('Cross-tab after failed refresh')).ok, true);
    await observer.waitForFunction(() => window.freshnessState === 'stale', null, { timeout: 15000 });
    const failure = await observer.evaluate(() => ({ title: window.observedTitle, message: nativeAPI.staleMessage() }));
    assert.equal(failure.title, 'Cross-tab single project');
    assert.match(failure.message, /Local refresh failed.*Synthetic project export failure.*last loaded data/);
    await observer.evaluate(() => {
      window.projectFault = null;
      window.projectWorkers.at(-1).onerror({ message: 'Synthetic worker exit before refresh retry' });
      window.freshnessStream.retryNow();
    });
    await observer.waitForFunction(() => window.freshnessState === 'live' && window.observedTitle === 'Cross-tab after failed refresh', null, { timeout: 30000 });
    await observer.evaluate(() => nativeAPI.openProject('*'));
    assert.equal((await change('Cross-tab combined projects')).ok, true);
    await observer.waitForFunction(() => window.observedTitle === 'Cross-tab combined projects', null, { timeout: 45000 });
    const result = await observer.evaluate(async () => ({
      snapshot: await nativeAPI.snapshot(), errors: window.freshnessErrors,
    }));
    assert.equal(result.snapshot.project.all, true);
    assert.equal(result.snapshot.issues.find(i => i.project === 'alpha' && i.type === 'task').title, 'Cross-tab combined projects');
    assert.equal(result.snapshot.issues.find(i => i.project === 'beta' && i.type === 'task').title, 'Native browser task');
    assert.deepEqual(result.errors, []);
    return { singleProject: true, combinedProjects: true, failedRefreshRetainedData: true, closedWorkerRetry: true };
  } finally {
    await observer.close();
    await writer.close();
  }
}
