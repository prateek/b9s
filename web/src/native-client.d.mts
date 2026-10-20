import type { WriteRequest } from './api.gen';

export interface NativeCommand extends WriteRequest {
  key: string;
  actor: string;
  email: string;
  expected: Record<string, string>;
}
export interface NativeWriteResult {
  ok: boolean;
  ids: string[];
  created: string;
}
export interface NativeMergePreview {
  ours: string;
  theirs: string;
  tables: { name: string; dataConflicts: number | null; schemaConflicts: number; rows: Record<string, unknown>[] }[];
}
export interface NativeResolution {
  key: string;
  ours: string;
  theirs: string;
  choices: { table: string; id: string; side: 'ours' | 'theirs' }[];
}
export interface NativeRuntime {
  state: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<unknown>;
  };
  request<T = Record<string, unknown>[]>(payload: { op: string; id?: string; command?: NativeCommand }): Promise<T>;
  close(reason?: string): void;
  previewMerge(entries: { key: string; bytes: Uint8Array }[], identity: { name: string; email: string }, branch?: string): Promise<NativeMergePreview>;
  resolveMerge(entries: { key: string; bytes: Uint8Array }[], identity: { name: string; email: string }, resolution: NativeResolution, branch?: string): Promise<{ ok: boolean; key: string }>;
  resolutionReceipt(identity: { name: string; email: string }, resolution: NativeResolution, branch?: string): Promise<{ state: 'absent' | 'recorded' | 'unknown' }>;
  mergeRemote(entries: { key: string; bytes: Uint8Array }[], identity: { name: string; email: string }, branch?: string): Promise<{
    head: string;
    fastForward: boolean;
    copiedChunks: number;
    message: string;
  }>;
  preparePush(entries: { key: string; bytes: Uint8Array }[], branch?: string): Promise<{
    head: string;
    changed: boolean;
    copiedChunks: number;
    containsLocalWorkingRoot: boolean;
    entries: { key: string; bytes: Uint8Array }[];
  }>;
}
export function openNativeRuntime(
  name: string,
  entries?: { key: string; bytes: Uint8Array }[],
  branch?: string,
): Promise<NativeRuntime>;
