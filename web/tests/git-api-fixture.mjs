import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { nativeEnv } from './native-readback.mjs';

export async function gitAPIFixture(source, work, { privateReads = false } = {}) {
  const root = mkdtempSync(`${work}/git-api-`);
  mkdirSync(`${root}/home`);
  const env = nativeEnv({ HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config` });
  execFileSync('git', ['clone', '--mirror', source, `${root}/remote.git`], { env, stdio: 'pipe', timeout: 30000 });
  const remote = `${root}/remote.git`;
  const git = (args, input, extra = {}) => execFileSync('git', [`--git-dir=${remote}`, ...args], {
    env: { ...env, ...extra }, input, maxBuffer: 64 << 20, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const text = (...args) => git(args).toString().trim();
  const validSHA = value => {
    if (!/^[a-f0-9]{40}$/.test(value)) throw Error('Invalid object ID');
    return value;
  };
  const ancestor = (a, b) => {
    try { git(['merge-base', '--is-ancestor', validSHA(a), validSHA(b)]); return true; }
    catch { return false; }
  };
  function writeTree(entries) {
    const root = new Map();
    for (const entry of entries) {
      if (entry.type !== 'blob' || entry.mode !== '100644') throw Error('Unsupported fixture tree entry');
      const path = entry.path.split('/');
      if (path.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw Error('Invalid tree path');
      let node = root;
      for (const part of path.slice(0, -1)) {
        if (!node.has(part)) node.set(part, new Map());
        node = node.get(part);
        if (!(node instanceof Map)) throw Error('Tree path collides with a blob');
      }
      const name = path.at(-1);
      if (node.has(name)) throw Error('Duplicate tree path');
      node.set(name, validSHA(entry.sha));
    }
    const write = node => {
      const entries = [...node.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return git(['mktree'], entries.map(([name, child]) => child instanceof Map
        ? `040000 tree ${write(child)}\t${name}\n`
        : `100644 blob ${child}\t${name}\n`).join('')).toString().trim();
    };
    return write(root);
  }
  const requests = [];
  let loseAcknowledgement = false;
  let unavailable = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    const authorized = req.headers.authorization === 'Bearer synthetic-git-token';
    requests.push({ method: req.method, path: req.url, authorized });
    const reply = (body, status = 200) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (unavailable) { reply({ message: 'Synthetic connection failure' }, 503); return; }
    if ((req.headers.authorization && !authorized) || ((req.method !== 'GET' || privateReads) && !authorized)) {
      reply({ message: 'Unauthorized' }, 401); return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 << 20) throw Error('Fixture request is too large');
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path.startsWith('/raw/fixture/data/')) {
        const [commit, ...parts] = path.slice('/raw/fixture/data/'.length).split('/');
        validSHA(commit);
        if (!parts.length || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw Error('Invalid raw path');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(git(['show', `${commit}:${parts.join('/')}`]));
        return;
      }
      const prefix = '/repos/fixture/data/';
      if (!path.startsWith(prefix)) { reply({}, 404); return; }
      const route = path.slice(prefix.length);
      if (req.method === 'GET' && route === 'git/ref/dolt/data') {
        reply({ ref: 'refs/dolt/data', object: { type: 'commit', sha: text('rev-parse', 'refs/dolt/data') } });
      } else if (req.method === 'GET' && route.startsWith('git/commits/')) {
        const sha = validSHA(route.slice('git/commits/'.length));
        const headers = text('cat-file', '-p', sha).split('\n\n')[0].split('\n');
        reply({ sha, tree: { sha: headers.find(line => line.startsWith('tree ')).slice(5) },
          parents: headers.filter(line => line.startsWith('parent ')).map(line => ({ sha: line.slice(7) })) });
      } else if (req.method === 'GET' && route.startsWith('git/trees/')) {
        const sha = validSHA(route.slice('git/trees/'.length));
        const entries = git(['ls-tree', '-z', sha]).toString().split('\0').filter(Boolean).map(line => {
          const [metadata, path] = line.split('\t');
          const [mode, type, sha] = metadata.split(' ');
          return { mode, type, sha, path };
        });
        reply({ sha, tree: entries, truncated: false });
      } else if (req.method === 'GET' && route.startsWith('git/blobs/')) {
        const sha = validSHA(route.slice('git/blobs/'.length));
        const bytes = git(['cat-file', 'blob', sha]);
        reply({ sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
      } else if (req.method === 'GET' && route.startsWith('compare/')) {
        const [base, head] = route.slice(8).split('...');
        reply({ status: base === head ? 'identical' : ancestor(base, head) ? 'ahead' : ancestor(head, base) ? 'behind' : 'diverged' });
      } else if (req.method === 'POST' && route === 'git/blobs') {
        if (body.encoding !== 'base64') throw Error('Expected base64 blob');
        reply({ sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')).toString().trim() }, 201);
      } else if (req.method === 'POST' && route === 'git/trees') {
        reply({ sha: writeTree(body.tree) }, 201);
      } else if (req.method === 'POST' && route === 'git/commits') {
        const args = ['commit-tree', validSHA(body.tree)];
        for (const parent of body.parents) args.push('-p', validSHA(parent));
        args.push('-m', body.message);
        const sha = git(args, undefined, { GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email }).toString().trim();
        reply({ sha }, 201);
      } else if (req.method === 'PATCH' && route === 'git/refs/dolt/data') {
        const before = text('rev-parse', 'refs/dolt/data');
        if (body.force !== false || !ancestor(before, body.sha)) { reply({ message: 'Not a fast-forward' }, 422); return; }
        git(['update-ref', 'refs/dolt/data', validSHA(body.sha), before]);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          unavailable = true;
          res.destroy();
          return;
        }
        reply({ ref: 'refs/dolt/data', object: { type: 'commit', sha: body.sha } });
      } else {
        reply({ message: 'Unsupported fixture endpoint' }, 404);
      }
    } catch (error) { reply({ message: error.message }, 400); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    remote, requests, origin: `http://127.0.0.1:${server.address().port}`,
    loseNextPublicationAcknowledgement: () => { loseAcknowledgement = true; },
    restore: () => { unavailable = false; },
    setUnavailable: value => { unavailable = value; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
