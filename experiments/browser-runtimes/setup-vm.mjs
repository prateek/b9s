import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-runtimes');
const target = `${root}/sources/linux`;
if (existsSync(target)) throw Error(`Choose a work directory without sources/linux: ${target}`);
mkdirSync(target, { recursive: true });
mkdirSync(`${root}/tmp`, { recursive: true });
const url = 'https://github.com/gastownhall/beads/releases/download/v1.3.1/beads_1.3.1_linux_amd64.tar.gz';
const sha256 = '3219443a9734b89b93fb16ee8d65844759fa1b3cd3cf139c606b7353cfb0715c';
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw Error(`Downloading native Beads: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== sha256) throw Error('Native Beads checksum mismatch');
writeFileSync(`${target}/upstream.tar.gz`, archive);
execFileSync('tar', ['-xzf', `${target}/upstream.tar.gz`, '-C', target], { timeout: 60000 });
execFileSync('go', ['build', '-o', `${target}/b9s`, './cmd/b9s'], {
  env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOTMPDIR: `${root}/tmp`, GOCACHE: resolve('.b9s-e2e/backend-free/go-cache') },
  stdio: 'inherit', timeout: 900000,
});
writeFileSync(`${target}/provenance.json`, JSON.stringify({ url, sha256, version: '1.3.1', commit: 'c1c4b642a' }, null, 2));
console.log(`VM inputs ready in ${target}. The default probe initializes its database in the guest.`);
