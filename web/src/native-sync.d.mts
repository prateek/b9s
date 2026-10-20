import type { NativeRuntime, NativeMergePreview, NativeResolution } from './native-client.mjs';
import type { GitRemote } from './git-remote.mjs';

export interface NativeSyncResult { commit: string; head: string; at: string }
export class NativeMergeConflictError extends Error {
  constructor(preview: NativeMergePreview);
  preview: NativeMergePreview;
}
export interface PendingResolution {
  resolution: NativeResolution;
  identity: { name: string; email: string };
  branch: string;
}
export function resolveNative(options: {
  runtime: NativeRuntime;
  remote: Pick<GitRemote, 'read'>;
  state: NativeRuntime['state'];
  identity: { name: string; email: string };
  resolution?: NativeResolution;
  branch?: string;
  onStatus?: (status: string) => void;
}): Promise<void>;
export function synchronizeNative(options: {
  runtime: NativeRuntime;
  remote: GitRemote;
  state: NativeRuntime['state'];
  identity: { name: string; email: string };
  branch?: string;
  reconcile?: boolean;
  onStatus?: (status: string) => void;
}): Promise<NativeSyncResult>;
