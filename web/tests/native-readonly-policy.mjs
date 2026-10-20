import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNativeOperation, applicationScope } from '../src/native-policy.mjs';

test('read-only workers reject every mutation and publication operation', () => {
  for (const op of ['save-state', 'prepare-push', 'merge-remote', 'resolve-merge', 'preview-merge']) {
    assert.throws(() => assertNativeOperation(true, op, {}), /read.only/i);
  }
  for (const op of ['write', 'receipt', 'resolution-receipt', 'unknown']) {
    assert.throws(() => assertNativeOperation(true, 'request', { op }), /read.only/i);
  }
});

test('read-only workers permit native issue reads and initialization', () => {
  for (const op of ['initialize', 'load-state']) assertNativeOperation(true, op, {});
  for (const op of ['export', 'issue']) assertNativeOperation(true, 'request', { op });
  assertNativeOperation(false, 'request', { op: 'write' });
});

test('directory and index URLs share the same application storage scope', () => {
  assert.equal(applicationScope('https://example.test/b9s/'), applicationScope('https://example.test/b9s/index.html'));
  assert.notEqual(applicationScope('https://example.test/b9s/'), applicationScope('https://example.test/other/'));
});
