import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [runtime, destination] = process.argv.slice(2).map(value => resolve(value));
if (!runtime || !destination) throw Error('Usage: package-browser.mjs <verified-runtime-directory> <new-release-directory>');
mkdirSync(destination);
const site = `${destination}/b9s-web`;
execFileSync(process.execPath, ['web/build.mjs', '--native', '--read-only', '--runtime', runtime, '--out', site], { stdio: 'inherit' });
writeFileSync(`${site}/native-config.json`, JSON.stringify({
  schema: 1,
  projects: [{ key: 'demo', name: 'Synthetic Beads demo', source: { repository: 'prateek/b9s', ref: 'refs/dolt/demo', branch: 'main' } }],
}, null, 2));
cpSync('LICENSE', `${site}/LICENSE`);
cpSync('docs/backend-free.md', `${site}/README.md`);
cpSync('third_party/beads/v1.3.1', `${site}/sources/beads`, { recursive: true });
cpSync('third_party/beads/browser', `${site}/sources/browser`, { recursive: true });
const archive = `${destination}/b9s-web.tar.gz`;
execFileSync('tar', ['-czf', archive, '-C', destination, 'b9s-web'], { stdio: 'inherit' });
writeFileSync(`${destination}/SHA256SUMS`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  b9s-web.tar.gz\n`);
console.log(destination);
