import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const vendor = resolve('third_party/beads/v1.3.1');
const pin = JSON.parse(readFileSync(`${vendor}/provenance.json`, 'utf8'));
const archive = readFileSync(`${vendor}/${pin.archive}`);
if (createHash('sha256').update(archive).digest('hex') !== pin.sha256) throw Error('Beads archive checksum mismatch');
const patches = readFileSync(`${vendor}/patches/series`, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
if (JSON.stringify(patches) !== JSON.stringify(pin.patches)) throw Error('Patch series differs from provenance');
const target = resolve(process.argv[2] || '.b9s-e2e/beads-build');
if (existsSync(target)) throw Error(`Build directory must be new: ${target}`);
mkdirSync(target, { recursive: true });
execFileSync('tar', ['-xzf', `${vendor}/${pin.archive}`, '--strip-components=1', '-C', target]);
execFileSync('git', ['init', '--quiet'], { cwd: target });
for (const patch of patches) {
  if (!/^[a-zA-Z0-9._-]+\.patch$/.test(patch)) throw Error('Invalid patch filename');
  execFileSync('git', ['apply', '--check', `${vendor}/patches/${patch}`], { cwd: target });
  execFileSync('git', ['apply', `${vendor}/patches/${patch}`], { cwd: target });
  execFileSync('git', ['apply', '--reverse', '--check', `${vendor}/patches/${patch}`], { cwd: target });
}
if (!process.argv.includes('--check-only')) execFileSync('go', ['build', '-tags=gms_pure_go', '-trimpath', '-o', `${target}/bd`, './cmd/bd'], {
  cwd: target, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '1' }, timeout: 900000,
});
console.log(`Verified ${pin.commit}; applied ${patches.length} patches; build tree: ${target}`);
