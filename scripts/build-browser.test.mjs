import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { verifyBrowserRuntime } from './build-browser.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(`${tmpdir()}/b9s-runtime-check-`);
  const runtime = `${root}/runtime`;
  mkdirSync(runtime);
  mkdirSync(`${root}/web/native`, { recursive: true });
  mkdirSync(`${root}/third_party/beads/browser`, { recursive: true });
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const compressed = gzipSync(wasm);
  writeFileSync(`${root}/web/native/input.go`, 'package main\n');
  writeFileSync(`${runtime}/native.wasm.gz`, compressed);
  writeFileSync(`${runtime}/wasm_exec.js`, 'runtime shim');
  const manifest = {
    schema: 1, kind: 'b9s-native',
    inputs: { 'web/native/input.go': hash('package main\n') },
    files: { 'native.wasm.gz': hash(compressed), 'wasm_exec.js': hash('runtime shim') },
    wasm: { sha256: hash(wasm), bytes: wasm.length },
  };
  const save = () => writeFileSync(`${runtime}/runtime.json`, JSON.stringify(manifest));
  save();
  return { root, runtime, manifest, save };
}

test('accepts the recorded runtime and rejects changed source inputs', () => {
  const f = fixture();
  assert.equal(verifyBrowserRuntime(f.runtime, f.root).kind, 'b9s-native');
  writeFileSync(`${f.root}/web/native/input.go`, 'package changed\n');
  assert.throws(() => verifyBrowserRuntime(f.runtime, f.root), /input/i);
});

test('rejects a runtime built before a new native source file was added', () => {
  const f = fixture();
  writeFileSync(`${f.root}/web/native/added.go`, 'package main\n');
  assert.throws(() => verifyBrowserRuntime(f.runtime, f.root), /input/i);
});

test('rejects a tampered compressed runtime', () => {
  const f = fixture();
  writeFileSync(`${f.runtime}/native.wasm.gz`, gzipSync('different runtime'));
  assert.throws(() => verifyBrowserRuntime(f.runtime, f.root), /checksum/i);
});

test('rejects a manifest that records the wrong decompressed runtime', () => {
  const f = fixture();
  f.manifest.wasm.sha256 = '0'.repeat(64);
  f.save();
  assert.throws(() => verifyBrowserRuntime(f.runtime, f.root), /decompressed/i);
});

test('rejects fixture builds and paths outside the recorded source root', () => {
  const f = fixture();
  f.manifest.kind = 'probe';
  f.save();
  assert.throws(() => verifyBrowserRuntime(f.runtime, f.root), /production/i);
  f.manifest.kind = 'b9s-native';
  f.manifest.inputs = { '../outside.go': '0'.repeat(64) };
  f.save();
  assert.throws(() => verifyBrowserRuntime(f.runtime, f.root), /path/i);
});
