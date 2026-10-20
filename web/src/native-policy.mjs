export const readOnly = typeof B9S_READ_ONLY !== 'undefined' && B9S_READ_ONLY;

export function applicationScope(url) {
  return new URL('./', url).href;
}

export function assertNativeOperation(readOnly, operation, payload) {
  if (!readOnly) return;
  if (operation === 'initialize' || operation === 'load-state') return;
  if (operation === 'request' && ['export', 'issue'].includes(payload?.op)) return;
  throw Error('This read-only release cannot modify or publish Beads data');
}
