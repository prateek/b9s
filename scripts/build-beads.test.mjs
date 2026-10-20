import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('vendored patches actually change an extracted build inside another Git worktree', () => {
  const scratch = resolve('.b9s-e2e');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(`${scratch}/patch-contract-`);
  const vendor = `${root}/third_party/beads/v1.3.1`;
  mkdirSync(`${vendor}/patches`, { recursive: true });
  mkdirSync(`${root}/original/upstream`, { recursive: true });
  writeFileSync(`${root}/original/upstream/example.txt`, 'before\n');
  execFileSync('tar', ['-czf', `${vendor}/upstream.tar.gz`, '-C', `${root}/original`, 'upstream']);
  const sha256 = createHash('sha256').update(readFileSync(`${vendor}/upstream.tar.gz`)).digest('hex');
  writeFileSync(`${vendor}/provenance.json`, JSON.stringify({ archive: 'upstream.tar.gz', sha256, commit: 'synthetic', patches: ['0001-example.patch'] }));
  writeFileSync(`${vendor}/patches/series`, '0001-example.patch\n');
  writeFileSync(`${vendor}/patches/0001-example.patch`, 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n');
  execFileSync(process.execPath, [resolve('scripts/build-beads.mjs'), `${root}/build`, '--check-only'], { cwd: root, timeout: 30000 });
  assert.equal(readFileSync(`${root}/build/example.txt`, 'utf8'), 'after\n');
  assert.equal(readFileSync(`${root}/original/upstream/example.txt`, 'utf8'), 'before\n');
});
