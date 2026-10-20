export interface NativeEntry { key: string; bytes: Uint8Array }
export interface GitPlan { repository: string; ref: string; base: string; commit: string; tree: string }
export class GitRemote {
  constructor(options: { repository: string; ref?: string; publicRead?: boolean; token?: () => string; fetch?: typeof fetch });
  read(): Promise<{ commit: string; tree: string; entries: NativeEntry[] }>;
  prepare(entries: NativeEntry[], base: string, identity: { name: string; email: string }): Promise<GitPlan>;
  publish(plan: GitPlan): Promise<string>;
}
export class GitConflictError extends Error { expected: string; actual: string }
export class GitOutcomeUnknownError extends Error { plan: GitPlan }
