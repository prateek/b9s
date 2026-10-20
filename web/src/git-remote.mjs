const SHA = /^[a-f0-9]{40}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PART_BYTES = 8 * 1024 * 1024;

export class GitConflictError extends Error {
  constructor(expected, actual) {
    super('The Git remote changed. Fetch and merge before publishing.');
    this.name = 'GitConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}
export class GitOutcomeUnknownError extends Error {
  constructor(plan) {
    super('Git publication could not be confirmed. Keep this prepared request and retry it.');
    this.name = 'GitOutcomeUnknownError';
    this.plan = plan;
  }
}
class GitHTTPError extends Error {
  constructor(status) {
    super(`GitHub request failed (HTTP ${status})`);
    this.status = status;
  }
}

function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) throw Error('Invalid Git object ID');
  return value;
}
function base64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(text);
}
async function blobID(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class GitRemote {
  constructor({ repository, ref = 'refs/dolt/data', publicRead = false, token = () => '', fetch: fetcher = globalThis.fetch.bind(globalThis) }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error('Invalid GitHub repository');
    if (!/^refs\/[A-Za-z0-9/_-][A-Za-z0-9._/-]*$/.test(ref) ||
        ref.includes('..') || ref.includes('//') || /[/.]$|\.lock$/.test(ref)) throw Error('Invalid Git reference');
    this.repository = repository;
    this.ref = ref;
    this.token = token;
    this.publicRead = publicRead;
    this.fetch = fetcher;
    this.blobs = new Map();
    this.baseURL = `https://api.github.com/repos/${repository}`;
    this.refPath = ref.slice(5).split('/').map(encodeURIComponent).join('/');
  }

  async request(path, method = 'GET', body) {
    if (this.publicRead && method !== 'GET') throw Error('This Git transport is read-only');
    const token = this.publicRead ? '' : this.token();
    if (method !== 'GET' && !token) throw Error('A GitHub token is required to publish changes');
    const response = await this.fetch(`${this.baseURL}/${path}`, {
      method, signal: AbortSignal.timeout(60000), redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new GitHTTPError(response.status);
    return response.json();
  }

  async head() {
    const result = await this.request(`git/ref/${this.refPath}`);
    if (result.ref !== this.ref || result.object?.type !== 'commit') throw Error('The configured reference does not name a Git commit');
    return sha(result.object.sha);
  }

  async tree(id) {
    const result = await this.request(`git/trees/${sha(id)}`);
    if (result.truncated) throw Error('GitHub returned a truncated native data tree');
    if (!Array.isArray(result.tree) || result.sha !== id) throw Error('Invalid native data tree');
    return result.tree;
  }

  async download(id, commit, path) {
    sha(id);
    if (this.blobs.has(id)) return this.blobs.get(id);
    let bytes;
    if (this.publicRead) {
      const response = await this.fetch(`https://raw.githubusercontent.com/${this.repository}/${sha(commit)}/${path}`, {
        signal: AbortSignal.timeout(60000), redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) throw new GitHTTPError(response.status);
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      const result = await this.request(`git/blobs/${id}`);
      if (result.encoding !== 'base64' || typeof result.content !== 'string') throw Error('GitHub did not return native blob bytes');
      bytes = Uint8Array.from(atob(result.content.replace(/\s/g, '')), character => character.charCodeAt(0));
      if (result.size !== bytes.length) throw Error('Native Git blob length mismatch');
    }
    if (await blobID(bytes) !== id) throw Error('Native Git blob checksum mismatch');
    this.blobs.set(id, bytes);
    return bytes;
  }

  async read() {
    const commit = await this.head();
    if (this.publicRead && this.lastRead?.commit === commit) return this.lastRead;
    const object = await this.request(`git/commits/${commit}`);
    if (object.sha !== commit) throw Error('GitHub returned the wrong commit');
    const tree = sha(object.tree?.sha);
    const entries = [];
    const names = new Set();
    for (const entry of await this.tree(tree)) {
      if (!KEY.test(entry.path) || names.has(entry.path)) throw Error('Invalid or duplicate native blob name');
      names.add(entry.path);
      let bytes;
      if (entry.type === 'blob' && entry.mode === '100644') {
        bytes = await this.download(entry.sha, commit, entry.path);
      } else if (entry.type === 'tree' && entry.mode === '040000') {
        const parts = (await this.tree(entry.sha)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        if (!parts.length) throw Error('Native multipart blob has no parts');
        const chunks = [];
        for (const [index, part] of parts.entries()) {
          if (part.path !== String(index + 1).padStart(4, '0') || part.path.length !== 4 ||
              part.type !== 'blob' || part.mode !== '100644') throw Error('Invalid native multipart blob');
          chunks.push(await this.download(part.sha, commit, `${entry.path}/${part.path}`));
        }
        bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      } else {
        throw Error('Unsupported entry in native Git data');
      }
      entries.push({ key: entry.path, bytes });
    }
    if (!names.has('manifest')) throw Error('The configured Git reference has no native Dolt manifest');
    const result = { commit, tree, entries };
    if (this.publicRead) this.lastRead = result;
    return result;
  }

  async upload(bytes) {
    const id = await blobID(bytes);
    if (!this.blobs.has(id)) {
      const uploaded = await this.request('git/blobs', 'POST', { encoding: 'base64', content: base64(bytes) });
      if (uploaded.sha !== id) throw Error('Uploaded native blob checksum mismatch');
      this.blobs.set(id, bytes);
    }
    return id;
  }

  async prepare(entries, base, identity) {
    sha(base);
    if (!identity?.name?.trim() || !identity?.email?.trim()) throw Error('A commit identity is required');
    const names = new Set();
    const files = [];
    for (const { key, bytes } of entries) {
      if (!KEY.test(key) || names.has(key) || !(bytes instanceof Uint8Array)) throw Error('Invalid native publish entry');
      names.add(key);
      const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
      if (parts > 9999) throw Error('Native blob exceeds the multipart limit');
      for (let index = 0; index < parts; index++) {
        files.push({
          path: parts === 1 ? key : `${key}/${String(index + 1).padStart(4, '0')}`,
          mode: '100644', type: 'blob',
          sha: await this.upload(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)),
        });
      }
    }
    if (!names.has('manifest')) throw Error('Cannot publish native data without a manifest');
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const tree = sha((await this.request('git/trees', 'POST', { tree: files })).sha);
    const commit = sha((await this.request('git/commits', 'POST', {
      message: 'b9s: synchronize native Beads data', tree, parents: [base], author: identity,
    })).sha);
    return { repository: this.repository, ref: this.ref, base, commit, tree };
  }

  async includesCommit(ancestor, current) {
    try {
      const comparison = await this.request(`compare/${sha(ancestor)}...${sha(current)}`);
      return comparison.status === 'ahead' || comparison.status === 'identical';
    } catch { return false; }
  }

  async publish(plan) {
    if (plan.repository !== this.repository || plan.ref !== this.ref) throw Error('Prepared publication belongs to a different repository or reference');
    sha(plan.base);
    sha(plan.commit);
    let current;
    try { current = await this.head(); }
    catch { throw new GitOutcomeUnknownError(plan); }
    if (current === plan.commit || (current !== plan.base && await this.includesCommit(plan.commit, current))) return current;
    if (current !== plan.base) throw new GitConflictError(plan.base, current);
    try {
      const result = await this.request(`git/refs/${this.refPath}`, 'PATCH', { sha: plan.commit, force: false });
      if (result.object?.sha !== plan.commit) throw Error('Unexpected Git reference update response');
      return plan.commit;
    } catch (error) {
      try { current = await this.head(); }
      catch { throw new GitOutcomeUnknownError(plan); }
      if (current === plan.commit || (current !== plan.base && await this.includesCommit(plan.commit, current))) return current;
      if (current !== plan.base) throw new GitConflictError(plan.base, current);
      if (error instanceof GitHTTPError && error.status >= 400 && error.status < 500) throw error;
      throw new GitOutcomeUnknownError(plan);
    }
  }
}
