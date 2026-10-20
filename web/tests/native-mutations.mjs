import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { GitRemote } from '../src/git-remote.mjs';
import { gitAPIFixture } from './git-api-fixture.mjs';
import { synchronize } from './native-readback.mjs';
import { expect } from '@playwright/test';

export async function exerciseNativeMutations(page, fixtureURL = './native-fixture.json', readback) {
  const result = await page.evaluate(async fixtureURL => {
    const { openNativeRuntime } = await import('./native-client.mjs');
    const entries = (await (await fetch(fixtureURL)).json()).map(({ key, bytes }) => ({
      key, bytes: Uint8Array.from(atob(bytes), character => character.charCodeAt(0)),
    }));
    const openTestRuntime = () => openNativeRuntime('mutation-contract', entries);
    let runtime = await openTestRuntime();
    const call = async payload => {
      if (payload.command) payload.command = { actor: 'Browser tester', email: 'browser@example.invalid', ...payload.command };
      return runtime.request(payload);
    };
    const detail = async () => (await call({ op: 'issue', id: 'browser-b' }))[0];
    const before = await detail();
    if (typeof before.revision !== 'string') throw Error('Native issue revision is missing');
    const command = {
      op: 'comment', ids: ['browser-b'], key: 'native-comment-001',
      expected: { 'browser-b': before.revision }, text: 'Guarded browser comment',
    };
    const first = await call({ op: 'write', command });
    const retry = await call({ op: 'write', command });
    const receipt = await call({ op: 'receipt', command });
    const absent = await call({ op: 'receipt', command: { ...command, key: 'native-absent-001' } });
    const after = await detail();
    const failures = {};
    for (const [name, changed] of Object.entries({
      reused: { ...command, text: 'Changed payload with the same key' },
      stale: { ...command, key: 'native-comment-002', text: 'Stale comment' },
      blocked: { op: 'close', ids: ['browser-b'], key: 'native-close-001', expected: { 'browser-b': after.revision } },
      blockedUpdate: { op: 'update', ids: ['browser-b'], key: 'native-update-close', expected: { 'browser-b': after.revision }, fields: { status: 'closed', notes: 'Must not survive a rejected close' } },
      blank: { ...command, key: 'native-comment-003', expected: { 'browser-b': after.revision }, text: '  ' },
    })) {
      try { await call({ op: 'write', command: changed }); failures[name] = ''; }
      catch (error) { failures[name] = error.message; }
    }
    const other = await openTestRuntime();
    const common = {
      op: 'comment', ids: ['browser-b'], expected: { 'browser-b': after.revision },
      actor: 'Browser tester', email: 'browser@example.invalid', text: 'Concurrent browser comment',
    };
    const race = await Promise.allSettled([
      call({ op: 'write', command: { ...common, key: 'native-race-001' } }),
      other.request({ op: 'write', command: { ...common, key: 'native-race-002' } }),
    ]);
    other.close();
    runtime.close();
    runtime = await openTestRuntime();
    const persistedRetry = await call({ op: 'write', command });
    const create = {
      op: 'create', key: 'native-create-001',
      fields: {
        title: 'Browser lifecycle fixture', type: 'task', priority: '1', labels: 'browser,test',
        description: 'Created description', design: 'Created design', acceptance: 'Created acceptance',
        notes: 'Created notes', assignee: 'creator@example.invalid', parent: 'browser-a',
      },
    };
    const created = await call({ op: 'write', command: create });
    const createRetry = await call({ op: 'write', command: create });
    const createdIssue = (await call({ op: 'issue', id: created.created }))[0];
    const lifecycle = [];
    let sequence = 0;
    const updateFields = {
      title: 'Updated browser fixture', notes: 'Native notes', 'add-label': 'edited', parent: 'browser-a',
      description: 'Updated description', design: 'Updated design', acceptance: 'Updated acceptance',
      priority: '0', type: 'feature', assignee: 'editor@example.invalid', status: 'in_progress',
    };
    for (const change of [
      { op: 'update', fields: updateFields },
      { op: 'defer', until: '2099-01-01' },
      { op: 'defer', until: '' },
      { op: 'close', reason: 'Lifecycle test' },
      { op: 'status', status: 'open' },
      { op: 'update', fields: { parent: '', 'remove-label': 'test' } },
    ]) {
      const current = (await call({op:'issue',id:created.created}))[0];
      await call({ op:'write', command: {
        ...change, ids:[created.created], key:`native-lifecycle-${++sequence}`,
        expected:{[created.created]:current.revision},
      }});
      lifecycle.push((await call({op:'issue',id:created.created}))[0]);
    }
    const last = lifecycle.at(-1);
    const child = await call({op:'write',command:{
      op:'create',key:'native-child-001',fields:{title:'Surviving child',parent:created.created},
    }});
    await call({op:'write',command:{
      op:'delete',ids:[created.created],key:'native-delete-001',expected:{[created.created]:last.revision},
    }});
    const survivor = (await call({op:'issue',id:child.created}))[0];
    await call({op:'write',command:{
      op:'delete',ids:[child.created],key:'native-delete-002',expected:{[child.created]:survivor.revision},
    }});
    const deleted = !(await call({op:'export'})).some(issue=>issue.id===created.created);
    const bulkIDs = [];
    for (const [index, title] of ['First bulk issue', 'Second bulk issue'].entries()) {
      const issue = await call({ op: 'write', command: {
        op: 'create', key: `native-bulk-create-${index}`, fields: { title },
      } });
      bulkIDs.push(issue.created);
    }
    const expectedFor = async ids => Object.fromEntries(await Promise.all(ids.map(async id => [
      id, (await call({ op: 'issue', id }))[0].revision,
    ])));
    const rejected = {
      op: 'close', key: 'native-bulk-rejected', ids: [bulkIDs[0], 'browser-b'],
      expected: await expectedFor([bulkIDs[0], 'browser-b']), text: 'Must roll back with blocked close',
    };
    let bulkError = '';
    try { await call({ op: 'write', command: rejected }); } catch (error) { bulkError = error.message; }
    const rolledBack = (await call({ op: 'issue', id: bulkIDs[0] }))[0];
    const rejectedReceipt = await call({ op: 'receipt', command: rejected });
    await call({ op: 'write', command: {
      op: 'status', key: 'native-bulk-status', ids: bulkIDs,
      expected: await expectedFor(bulkIDs), status: 'in_progress',
    } });
    const bulkStarted = await Promise.all(bulkIDs.map(async id => (await call({ op: 'issue', id }))[0]));
    let ambiguousClose = '';
    try {
      await call({ op: 'write', command: {
        op: 'close', key: 'native-ambiguous-close', ids: bulkIDs,
        expected: await expectedFor(bulkIDs), reason: 'Bulk completed', text: 'Bulk close comment',
      } });
    } catch (error) { ambiguousClose = error.message; }
    await call({ op: 'write', command: {
      op: 'close', key: 'native-bulk-close', ids: bulkIDs,
      expected: await expectedFor(bulkIDs), text: 'Bulk close comment',
    } });
    const bulkClosed = await Promise.all(bulkIDs.map(async id => (await call({ op: 'issue', id }))[0]));
    await call({ op: 'write', command: {
      op: 'delete', key: 'native-bulk-delete', ids: bulkIDs, expected: await expectedFor(bulkIDs),
    } });
    const bulkDeleted = !(await call({ op: 'export' })).some(issue => bulkIDs.includes(issue.id));
    const retained = await call({ op: 'write', command: { ...create, key: 'native-retained-create' } });
    await call({ op: 'write', command: {
      op: 'update', key: 'native-retained-update', ids: [retained.created],
      expected: await expectedFor([retained.created]), fields: updateFields,
    } });
    const prepared = await runtime.preparePush(entries);
    const published = prepared.entries.map(({ key, bytes }) => {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
      return { key, bytes: btoa(binary) };
    });
    const result = {
      first, retry, receipt, absent, persistedRetry, created, createRetry, createdIssue, lifecycle, survivor, deleted,
      bulkError, rolledBack, rejectedReceipt, bulkStarted, bulkClosed, bulkDeleted, ambiguousClose,
      retained: retained.created, published,
      beforeCount: before.comments.length, beforeNotes: before.notes || '', after: await detail(), failures,
      race: race.map(item => ({ status: item.status, error: item.status === 'rejected' ? item.reason.message : '' })),
    };
    runtime.close();
    return result;
  }, fixtureURL);
  assert.equal(result.first.ok, true);
  assert.deepEqual(result.retry, result.first);
  assert.equal(result.receipt.state, 'recorded');
  assert.equal(result.absent.state, 'absent');
  assert.deepEqual(result.persistedRetry, result.first);
  assert.equal(result.after.comments.length, result.beforeCount + 2);
  assert.equal(result.race.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(result.race.find(item => item.status === 'rejected').error, /stale/i);
  assert.equal(result.after.status, 'open');
  assert.match(result.failures.reused, /key.*different|different.*key/i);
  assert.match(result.failures.stale, /stale|changed/i);
  assert.match(result.failures.blocked, /blocked/i);
  assert.match(result.failures.blockedUpdate, /blocked/i);
  assert.equal(result.after.notes || '', result.beforeNotes);
  assert.match(result.failures.blank, /empty|blank/i);
  assert.deepEqual(result.created, result.createRetry);
  assert.ok(result.created.created);
  for (const [field, value] of Object.entries({
    description: 'Created description', design: 'Created design', acceptance_criteria: 'Created acceptance',
    notes: 'Created notes', assignee: 'creator@example.invalid', priority: 1, issue_type: 'task',
  })) assert.equal(result.createdIssue[field], value, `create ${field}`);
  assert.deepEqual([...result.createdIssue.labels].sort(), ['browser', 'test']);
  assert.equal(result.createdIssue.dependencies[0].depends_on_id, 'browser-a');
  assert.equal(result.lifecycle[0].title, 'Updated browser fixture');
  assert.equal(result.lifecycle[0].notes, 'Native notes');
  for (const [field, value] of Object.entries({
    description: 'Updated description', design: 'Updated design', acceptance_criteria: 'Updated acceptance',
    assignee: 'editor@example.invalid', priority: 0, issue_type: 'feature', status: 'in_progress',
  })) assert.equal(result.lifecycle[0][field], value, `update ${field}`);
  assert.ok(result.lifecycle[0].labels.includes('edited'));
  assert.equal(result.lifecycle[0].dependencies[0].type, 'parent-child');
  assert.match(result.lifecycle[1].defer_until, /^2099-01-01/);
  assert.equal(result.lifecycle[1].status, 'deferred');
  assert.equal(result.lifecycle[2].status, 'deferred');
  assert.match(result.lifecycle[2].defer_until, /^2099-01-01/);
  assert.equal(result.lifecycle[3].status, 'closed');
  assert.equal(result.lifecycle[3].close_reason, 'Lifecycle test');
  assert.equal(result.lifecycle[4].status, 'open');
  assert.equal(result.lifecycle[5].labels.includes('test'), false);
  assert.equal(result.lifecycle[5].dependencies?.length || 0, 0);
  assert.equal(result.deleted, true);
  assert.equal(result.survivor.title, 'Surviving child');
  assert.equal(result.survivor.dependencies?.length || 0, 0);
  assert.match(result.bulkError, /blocked/i);
  assert.equal(result.rolledBack.status, 'open');
  assert.equal(result.rolledBack.comments?.length || 0, 0);
  assert.equal(result.rejectedReceipt.state, 'absent');
  assert.deepEqual(result.bulkStarted.map(issue => issue.status), ['in_progress', 'in_progress']);
  assert.deepEqual(result.bulkClosed.map(issue => issue.status), ['closed', 'closed']);
  assert.match(result.ambiguousClose, /comment or a reason, not both/);
  assert.ok(result.bulkClosed.every(issue => issue.comments.some(comment => comment.text === 'Bulk close comment')));
  assert.equal(result.bulkDeleted, true);
  const { published, ...report } = result;
  if (readback) {
    const github = await gitAPIFixture(readback.source, readback.evidenceRoot);
    try {
      const remote = new GitRemote({
        repository: 'fixture/data', token: () => 'synthetic-git-token',
        fetch: (url, options) => fetch(url.replace('https://api.github.com', github.origin), options),
      });
      const base = await remote.head();
      const plan = await remote.prepare(published.map(({ key, bytes }) => ({ key, bytes: new Uint8Array(Buffer.from(bytes, 'base64')) })),
        base, { name: 'Mutation tester', email: 'mutations@example.invalid' });
      await remote.publish(plan);
      const work = mkdtempSync(`${readback.evidenceRoot}/mutation-readback-`);
      const native = synchronize({ remote: github.remote, bd: readback.bd, work: `${work}/native` });
      const issue = native.snapshot.issues.find(issue => issue.id === result.retained);
      for (const [field, value] of Object.entries({
        title: 'Updated browser fixture', description: 'Updated description', design: 'Updated design',
        acceptance: 'Updated acceptance', notes: 'Native notes', assignee: 'editor@example.invalid',
        priority: 0, type: 'feature', status: 'in_progress', parent: 'browser-a',
      })) assert.equal(issue[field], value, `native bd readback ${field}`);
      assert.deepEqual([...issue.labels].sort(), ['browser', 'edited', 'test']);
      assert.equal(native.snapshot.issues.find(issue => issue.id === 'browser-b').comments.length, result.beforeCount + 2);
      report.nativeReadback = { issue, revision: native.revision };
    } finally { await github.close(); }
  }
  return report;
}

export async function exerciseNativeLifecycleUI(page, screenshot) {
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await page.locator('#fTitle').fill('Mobile lifecycle issue');
  await page.locator('#fParent').selectOption('browser-a');
  await page.locator('#fAssignee').fill('mobile@example.invalid');
  await page.locator('#fLabels').fill('mobile, native');
  await page.locator('#fDesc').fill('Created on a phone');
  await page.locator('[data-seg="type"] [data-v="bug"]').click();
  await page.locator('[data-seg="priority"] [data-v="1"]').click();
  await page.locator('[data-sa="docreate"]').click();
  const row = page.locator('#treeRows .row', { hasText: 'Mobile lifecycle issue' });
  await expect(row).toBeVisible();
  const id = await row.getAttribute('data-id');
  assert.ok(id);
  await row.click();
  await expect(page.locator('.detail')).toContainText('Created on a phone');
  await expect(page.locator('.detail')).toContainText('Native browser epic');
  await page.locator('.detail .dacts [data-act="edit"]').click();
  await page.locator('#fTitle').fill('Mobile lifecycle edited');
  await page.locator('#fDesc').fill('Updated on a phone');
  await page.locator('#fNotes').fill('Native notes from the mobile form');
  await page.locator('#fAssignee').fill('editor@example.invalid');
  await page.locator('#fLabels').fill('mobile, edited');
  await page.locator('[data-seg="type"] [data-v="feature"]').click();
  await page.locator('[data-seg="priority"] [data-v="0"]').click();
  await page.locator('[data-seg="status"] [data-v="in_progress"]').click();
  await page.locator('[data-sa="save"]').click();
  await expect(page.locator('.detail .dtitle')).toHaveText('Mobile lifecycle edited');
  await expect(page.locator('.detail .pill.status')).toHaveText('in progress');
  await expect(page.locator('.detail')).toContainText('Native notes from the mobile form');
  await expect(page.locator('.detail')).toContainText('@editor@example.invalid');
  await expect(page.locator('.detail .pills')).toContainText('#edited');
  await expect(page.locator('.detail .pills')).not.toContainText('#native');
  await page.locator('.detail .dacts [data-act="status"]').click();
  await page.locator('[data-sa="defer"]').click();
  await page.locator('#fUntil').fill('2099-01-01');
  await page.locator('[data-sa="dodefer"]').click();
  await expect(page.locator('.detail .pill.status')).toHaveText('deferred');
  await page.locator('.detail .dacts [data-act="status"]').click();
  await page.locator('[data-sa="setstatus"][data-val="closed"]').click();
  await page.locator('#fCloseComment').fill('Completed in the mobile lifecycle test');
  await page.locator('[data-sa="doclose"]').click();
  await expect(page.locator('.detail .pill.status')).toHaveText('closed');
  await expect(page.locator('.detail')).toContainText('Completed in the mobile lifecycle test');
  await page.screenshot({ path: screenshot });
  await page.locator('.detail .dacts [data-act="status"]').click();
  await page.locator('[data-sa="setstatus"][data-val="open"]').click();
  await expect(page.locator('.detail .pill.status')).toHaveText('open');
  await page.locator('.detail .dacts [data-act="actions"]').click();
  await page.locator('[data-sa="delete"]').click();
  await expect(page.locator('.msheet .cmd')).toContainText(id);
  await page.locator('[data-sa="dodelete"]').click();
  await expect(page.locator(`.detail[data-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator(`#treeRows .row[data-id="${id}"]`)).toHaveCount(0);
  return { id, create: true, update: true, defer: true, close: true, reopen: true, delete: true };
}
