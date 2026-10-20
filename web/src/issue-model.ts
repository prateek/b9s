import type { Issue } from './api.gen';

interface NativeIssue {
  id: string; title: string; issue_type: string; status: string; priority: number;
  description?: string; design?: string; acceptance_criteria?: string; notes?: string;
  assignee?: string; created_by?: string; created_at?: string; updated_at?: string;
  source_repo?: string;
  closed_at?: string; defer_until?: string; due_at?: string; labels?: string[];
  dependencies?: { depends_on_id: string; type: string }[];
  comments?: { author: string; text: string; created_at: string }[];
}

export function projectExport(jsonl: string): Issue[] {
  const rows: NativeIssue[] = jsonl.split('\n').filter(s => s.trim()).map(s => JSON.parse(s));
  const closed = (status: string) => ['closed', 'tombstone'].includes(status);
  const byID = new Map(rows.map(r => [r.id, r]));
  if (byID.size !== rows.length) throw Error('Duplicate issue ID in native export');
  return rows.map(r => {
    if (typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.status !== 'string') throw Error('Invalid native issue');
    const deps = r.dependencies || [];
    const links = (type: string) => deps.filter(d => d.type === type).map(d => d.depends_on_id);
    const blockers = deps.filter(d => !d.type || d.type === 'blocks').map(d => d.depends_on_id);
    const blocked = !closed(r.status) && (r.status === 'blocked' || blockers.some(id => byID.has(id) && !closed(byID.get(id)!.status)));
    return {
      id: r.id, title: r.title, type: r.issue_type, status: r.status, priority: r.priority,
      description: r.description || '', design: r.design || '', acceptance: r.acceptance_criteria || '', notes: r.notes || '',
      assignee: r.assignee || '', created_by: r.created_by || '', created_at: r.created_at || '', updated_at: r.updated_at || '',
      closed_at: r.closed_at || '', defer_until: r.defer_until || '', due: r.due_at || '', labels: r.labels || [],
      parent: links('parent-child')[0] || '', blocked_by: blockers, related: links('related'), discovered_from: links('discovered-from'),
      comments: r.comments || [], comment_count: r.comments?.length || 0, project: r.source_repo || repoPrefix(r.id),
      summary: r.issue_type === 'epic' ? firstSentence(r.description || '') : '',
      blocked, ready: !closed(r.status) && !blocked, closed_like: closed(r.status),
      memory_available: false, memory_loading: false, memory_links: [],
    };
  });
}

export function queryIssues(issues: Issue[], query: string): string[] {
  const predicates: { field: string; value: string; negated: boolean }[] = [];
  const plain: string[] = [];
  for (let token of words(query)) {
    const negated = token.startsWith('!');
    if (negated) token = token.slice(1);
    const colon = token.indexOf(':');
    if (colon > 0) {
      const value = lower(token.slice(colon + 1));
      if (value) predicates.push({ field: lower(token.slice(0, colon)), value, negated });
    } else if (negated) predicates.push({ field: 'status', value: lower(token), negated });
    else plain.push(token);
  }
  if (plain.length) predicates.push({ field: '', value: lower(plain.join(' ')), negated: false });
  const match = (issue: Issue, field: string, value: string): boolean => {
    switch (field) {
      case '': return words(value).every(term => [issue.id, issue.title, ...issue.labels].some(candidate => fuzzyMatch(candidate, term)));
      case 'branch': return lower(issue.id) === value;
      case 'priority': return String(issue.priority) === value.replace(/^p/, '');
      case 'label': return issue.labels.some(label => fuzzyMatch(label, value));
      case 'project': return fuzzyMatch(issue.project || repoPrefix(issue.id), value);
      case 'id': case 'title': case 'status': case 'type': case 'assignee': return fuzzyMatch(issue[field], value);
      default: return false;
    }
  };
  return issues.filter(issue => {
    const positive = new Map<string, boolean>();
    for (const { field, value, negated } of predicates) {
      const matches = match(issue, field, value);
      if (negated && matches) return false;
      if (!negated) positive.set(field, !!positive.get(field) || matches);
    }
    return [...positive.values()].every(Boolean);
  }).map(issue => issue.id);
}

// Match Go's rune-wise lowercase and strings.Fields, rather than locale or phrase casing.
const lower = (text: string) => Array.from(text, rune => rune === '\u0130' ? 'i' : rune.toLowerCase()).join('');
const whitespace = '[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const whitespaceRuns = new RegExp(`${whitespace}+`, 'u');
const whitespaceEdges = new RegExp(`^${whitespace}+|${whitespace}+$`, 'gu');
const words = (text: string) => text.split(whitespaceRuns).filter(Boolean);
const utf8 = new TextEncoder();

function firstSentence(text: string): string {
  const trim = (value: string) => value.replace(whitespaceEdges, '');
  const lines = trim(text).split('\n');
  while (lines.length && (!trim(lines[0]) || trim(lines[0]).startsWith('#'))) lines.shift();
  text = lines.join('\n');
  const paragraph = text.indexOf('\n\n');
  if (paragraph >= 0) text = trim(text.slice(0, paragraph));
  for (const marker of ['-', '*', '+']) {
    if (text.startsWith(marker)) {
      let start = 0;
      while (text[start] === marker || text[start] === ' ') start++;
      text = text.slice(start);
      break;
    }
  }
  text = words(text).join(' ');
  const end = /[.!?](?= |$)/u.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

function fuzzyMatch(candidate: string, query: string): boolean {
  query = lower(words(query).join(' '));
  if (!query) return false;
  candidate = lower(candidate);
  if (candidate.includes(query)) return true;
  const needle = utf8.encode(words(query).join(''));
  if (needle.length > 16) return false;
  const terms = words(candidate);
  for (let start = 0; start < terms.length; start++) {
    let window = '';
    for (let end = start; end < terms.length && end < start + 2; end++) {
      window += terms[end];
      let matched = 0;
      for (const byte of utf8.encode(window)) {
        if (byte === needle[matched]) matched++;
        if (matched === needle.length) return true;
      }
    }
  }
  return false;
}

function repoPrefix(id: string): string {
  for (const separator of ['-', ':', '_']) {
    const position = id.indexOf(separator);
    if (position > 0 && position <= 10 && /^[A-Za-z0-9]+$/.test(id.slice(0, position))) return id.slice(0, position);
  }
  return '';
}
