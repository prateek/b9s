import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { projectExport, queryIssues } from '../src/issue-model.ts';

const rows = [
  { id: 'api-a', title: 'Keyboard navigation', issue_type: 'task', status: 'open', priority: 1, labels: ['mobile-accessibility'], assignee: 'Prateek', source_repo: 'services' },
  { id: 'api-a.1', title: 'Native database mappings', issue_type: 'bug', status: 'in_progress', priority: 2, labels: ['storage'], assignee: 'Morgan' },
  { id: 'web-b', title: 'Improve mobile board', issue_type: 'epic', status: 'closed', priority: 0, labels: ['frontend'], assignee: '' },
  { id: 'api-a.10', title: 'one two three four five six seven eight nine ten', issue_type: 'task', status: 'deferred', priority: 3, labels: [], source_repo: '.' },
  { id: 'unicode-c', title: 'Übersicht İSTANBUL ΟΣ', issue_type: 'task', status: 'open', priority: 4, labels: ['ééééééééé'] },
];
const queries = [
  '', '   ', 'status:open status:closed', 'type:task type:bug !status:deferred',
  'type:task !open', '!type:epic !status:deferred', '!unknown:value', 'unknown:value',
  'status:', '!status:', 'type:task priority:P1', 'priority:2', 'priority:01',
  'branch:api-a.1', 'branch:API-A.1', 'id:api-a.1', 'title:kbnv',
  'label:mac', 'assignee:ptk', 'project:services', 'project:api', 'project:.',
  'api mapping', 'kbnv mobile', 'native storage', '"mobile board"',
  'title:nativemappings', 'title:onetwothreefour', 'title:onetwothreefourfive',
  'title:one title:board', ':open', '!!open', 'ready:true', 'parent:api-a',
  'title:übersicht', 'title:istanbul', 'title:οσ', 'label:ééééééééé',
];
const expected = JSON.parse(execFileSync('go', ['run', './web/tests/query-oracle'], {
  input: JSON.stringify({ issues: rows, queries }), encoding: 'utf8', timeout: 120000,
}));
const issues = projectExport(rows.map(row => JSON.stringify(row)).join('\n'));
for (const query of queries) {
  test(`browser matches canonical b9s query ${JSON.stringify(query)}`, () => {
    assert.deepEqual(queryIssues(issues, query), expected[query]);
  });
}

const descriptions = [
  'First sentence. Another sentence.',
  '# Goal\n\nSync invoices from the billing API',
  '- first bullet\nsecond line',
  'Is it done? Not yet.',
  'Version 2.1 ships soon. Then 3.',
  'One paragraph\n\nAnother paragraph.',
  '', '  \n  ', '## Heading only', '* * nested markers',
  'Heading\r\n\r\nNext paragraph.', '\u0085Wide\u00a0space!\u2028Next sentence.',
];
const summaries = JSON.parse(execFileSync('go', ['run', './web/tests/query-oracle'], {
  input: JSON.stringify({ summaries: descriptions }), encoding: 'utf8', timeout: 120000,
}));
for (const [index, description] of descriptions.entries()) {
  test(`browser epic summary matches b9s for ${JSON.stringify(description)}`, () => {
    const [issue] = projectExport(JSON.stringify({
      id: 'summary-a', title: 'Summary fixture', issue_type: 'epic', status: 'open', priority: 2, description,
    }));
    assert.equal(issue.summary, summaries[index]);
  });
}
