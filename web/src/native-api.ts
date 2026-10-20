import type { Health, Issue, MemoryGraphResponse, ProjectInfo, ProjectList, QueryResult, Session, Snapshot, WriteRequest, WriteResult } from './api.gen';
import type { LiveHandlers } from './api';
import type { NativeCommand, NativeRuntime, NativeWriteResult, NativeMergePreview, NativeResolution } from './native-client.mjs';
import { projectExport, queryIssues } from './issue-model';
import { uid } from './util';
import { readOnly, applicationScope } from './native-policy.mjs';
import { GitRemote } from './git-remote.mjs';
import { synchronizeNative, resolveNative, NativeMergeConflictError, type PendingResolution } from './native-sync.mjs';

interface Project {
  key: string;
  name: string;
  bootstrap?: string;
  source?: { repository: string; ref?: string; branch?: string };
}
interface Configuration { schema: 1; projects: Project[]; identity?: { name: string; email: string } }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const optimisticWrites = false;
export const staleMessage = () => localRefreshError || 'Offline: using the local Beads database';

let config: Configuration;
let active: Project;
let runtime: NativeRuntime | undefined;
const runtimeRevisions = new WeakMap<NativeRuntime, string>();
let current: Snapshot;
let version = 0;
let selection = 0;
let handlers: LiveHandlers | undefined;
let mergeConflicts: NativeMergePreview | undefined;
let pendingResolution: PendingResolution | undefined;
const conflictChoices = new Map<string, 'ours' | 'theirs'>();
let revisions: Record<string, string> = {};
let pending: { project: string; command: NativeCommand } | undefined;
let applying = false;
let switching = false;
let feedback = '';
let syncing = false;
let syncFeedback = '';
let offlineFeedback = 'Preparing offline files…';
let preparingOffline = false;
let offlineReady = false;
let cachedConfiguration = false;
let localRefreshError = '';
const tokens = new Map<string, string>();
const remotes = new Map<string, GitRemote>();
const allProjects: Project = { key: '*', name: 'All projects' };

function storageName(project: Project): string {
  return `${applicationScope(location.href)}${readOnly ? ':reader' : ''}:${project.key}${project.source
    ? `:${project.source.repository}:${project.source.ref || 'refs/dolt/data'}:${project.source.branch || 'main'}` : ''}`;
}

function gitRemote(project: Project): GitRemote {
  if (!project.source) throw Error('No Git repository is configured for this project');
  const key = storageName(project);
  if (!remotes.has(key)) remotes.set(key, new GitRemote({ ...project.source, publicRead: readOnly, token: () => tokens.get(project.key) || '' }));
  return remotes.get(key)!;
}

function authenticate(project: Project): Promise<void> {
  if (readOnly) return Promise.reject(Error('This release reads public repositories without authentication'));
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sync-dialog';
    dialog.innerHTML = '<form><h2>Connect to GitHub</h2><p class="repository"></p><p>Enter a fine-grained token with Contents access to this repository. Use read and write access to publish changes. The token stays in memory until this page closes.</p><label>GitHub token <input type="password" name="token" autocomplete="off" required></label><button type="submit">Connect</button><button type="button" class="cancel">Cancel</button></form>';
    dialog.querySelector('.repository')!.textContent = project.source?.repository || project.name;
    const finish = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('form')!.onsubmit = event => {
      event.preventDefault();
      const input = dialog.querySelector('input')!;
      const token = input.value.trim();
      if (!token) return;
      tokens.set(project.key, token);
      input.value = '';
      finish();
      resolve();
    };
    const cancel = () => { finish(); reject(Error('GitHub connection cancelled')); };
    dialog.querySelector<HTMLButtonElement>('.cancel')!.onclick = cancel;
    dialog.oncancel = event => { event.preventDefault(); cancel(); };
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function readJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (!response.ok) throw new ApiError(response.status, `Loading ${path}: HTTP ${response.status}`);
  if (path === 'native-config.json') cachedConfiguration = response.headers.get('X-B9s-Offline') === '1';
  return response.json();
}

async function openRuntime(project: Project): Promise<NativeRuntime> {
  const { openNativeRuntime } = await import('./native-client.mjs');
  let next: NativeRuntime;
  const name = storageName(project);
  const branch = project.source?.branch || 'main';
  if (readOnly && project.source) {
    const pointer = `${name}:revision`;
    let incoming;
    try {
      incoming = await gitRemote(project).read();
    } catch (error) {
      const cached = localStorage.getItem(pointer);
      if (!cached || !/^[a-f0-9]{40}$/.test(cached)) throw error;
      localRefreshError = `Remote refresh failed: ${String(error)}. Showing the last loaded native database.`;
      return openNativeRuntime(`${name}:${cached}`, undefined, branch);
    }
    if (runtime && active === project && runtimeRevisions.get(runtime) === incoming.commit) {
      localRefreshError = '';
      return runtime;
    }
    next = await openNativeRuntime(`${name}:${incoming.commit}`, incoming.entries, branch);
    try {
      await next.request({ op: 'export' });
      localStorage.setItem(pointer, incoming.commit);
      runtimeRevisions.set(next, incoming.commit);
      localRefreshError = '';
      return next;
    } catch (error) {
      next.close();
      throw error;
    }
  }
  try {
    next = await openNativeRuntime(name, undefined, branch);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No native Beads database')) throw error;
    if (project.source) {
      let incoming;
      try { incoming = await gitRemote(project).read(); }
      catch (failure) {
        if (!(failure instanceof Error) || !/HTTP (401|403|404)/.test(failure.message)) throw failure;
        await authenticate(project);
        incoming = await gitRemote(project).read();
      }
      next = await openNativeRuntime(name, incoming.entries, branch);
    } else {
      if (!project.bootstrap) throw error;
      const blobs = await readJSON<{ key: string; bytes: string }[]>(project.bootstrap);
      next = await openNativeRuntime(name, blobs.map(({ key, bytes }) => ({
        key, bytes: Uint8Array.from(atob(bytes), c => c.charCodeAt(0)),
      })));
    }
  }
  return next;
}

async function connect(project: Project): Promise<void> {
  const next = await openRuntime(project);
  try {
    const nextPending = await next.state.get<typeof pending>('command') || undefined;
    const nextResolution = await next.state.get<PendingResolution>('resolution') || undefined;
    const last = await next.state.get<{ at: string }>('last-sync');
    const publication = await next.state.get('publication');
    const loaded = await loadSnapshot(next, project, nextPending, nextResolution);
    if (runtime !== next) runtime?.close();
    runtime = next;
    active = project;
    selection++;
    pending = nextPending;
    pendingResolution = nextResolution;
    mergeConflicts = undefined;
    conflictChoices.clear();
    feedback = '';
    syncFeedback = publication
      ? 'Unresolved publication. Sync will check and retry its original commit.'
      : last ? `Last synchronized: ${new Date(last.at).toLocaleString()}` : '';
    publishSnapshot(loaded);
  } catch (error) {
    if (runtime !== next) next.close();
    throw error;
  }
}

function projectInfo(project: Project, command: typeof pending, resolution: typeof pendingResolution): ProjectInfo {
  return { key: project.key, name: project.name, read_only: readOnly || project === allProjects || !config.identity || !!command || !!resolution || syncing, all: project === allProjects };
}

async function loadSnapshot(client: NativeRuntime, project: Project, command: typeof pending, resolution: typeof pendingResolution) {
  const rows = await client.request({ op: 'export' });
  const nextRevisions = Object.fromEntries(rows.map(row => [String(row.id), String(row.revision)]));
  const issues = projectExport(rows.map(row => JSON.stringify(row)).join('\n'));
  const health: Health = {
    ok: true, kind: 'native-browser', source: project.name, watching: 'Local database changes',
    loaded_at: new Date().toISOString(), issues: issues.length, fallback: '', error: '', bd_found: true,
  };
  const snapshot: Snapshot = { version: 0, project: projectInfo(project, command, resolution), actor: config.identity?.name || '', people: [], health, issues };
  return { snapshot, revisions: nextRevisions };
}

function publishSnapshot(loaded: Awaited<ReturnType<typeof loadSnapshot>>): Snapshot {
  revisions = loaded.revisions;
  current = { ...loaded.snapshot, version: ++version };
  return current;
}

async function loadAllSnapshot(): Promise<Awaited<ReturnType<typeof loadSnapshot>>> {
  const issues: Issue[] = [];
  for (const project of config.projects) {
    let client: NativeRuntime | undefined;
    try {
      client = await openRuntime(project);
      const loaded = await loadSnapshot(client, project, undefined, undefined);
      const qualify = (id: string) => id ? `${encodeURIComponent(project.key)}::${id}` : '';
      issues.push(...loaded.snapshot.issues.map(issue => ({
        ...issue, id: qualify(issue.id), project: project.name,
        parent: qualify(issue.parent),
        blocked_by: issue.blocked_by.map(qualify),
        related: issue.related.map(qualify),
        discovered_from: issue.discovered_from.map(qualify),
      })));
    } catch (error) {
      throw Error(`Loading ${project.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { client?.close(); }
  }
  return {
    revisions: {},
    snapshot: {
      version: 0, project: projectInfo(allProjects, undefined, undefined),
      actor: '', people: [], issues,
      health: {
        ok: true, kind: 'native-browser', source: `${config.projects.length} local databases`,
        watching: 'Local database changes', loaded_at: new Date().toISOString(),
        issues: issues.length, fallback: '', error: '', bd_found: true,
      },
    },
  };
}

async function connectAll(): Promise<void> {
  const loaded = await loadAllSnapshot();
  runtime?.close();
  runtime = undefined;
  active = allProjects;
  selection++;
  pending = undefined;
  pendingResolution = undefined;
  mergeConflicts = undefined;
  conflictChoices.clear();
  feedback = 'This combined view is read-only. Open a project to edit or synchronize it.';
  syncFeedback = '';
  publishSnapshot(loaded);
}

async function readSnapshot(): Promise<Snapshot> {
  const started = selection;
  const project = active;
  const client = runtime;
  if (!client && project !== allProjects) throw Error('Beads runtime has not initialized');
  try {
    const storedPending = client ? await client.state.get<typeof pending>('command') || undefined : undefined;
    const storedResolution = client ? await client.state.get<PendingResolution>('resolution') || undefined : undefined;
    const loaded = project === allProjects ? await loadAllSnapshot() : await loadSnapshot(client!, project, storedPending, storedResolution);
    if (started !== selection) return current;
    if (!applying && !syncing && !switching) {
      pending = storedPending;
      pendingResolution = storedResolution;
    }
    loaded.snapshot.project = projectInfo(active, pending, pendingResolution);
    return publishSnapshot(loaded);
  } catch (error) {
    if (started !== selection) return current;
    throw error;
  }
}

export async function session(): Promise<Session> {
  config = await readJSON<Configuration>('native-config.json');
  if (config.schema !== 1 || !Array.isArray(config.projects) || !config.projects.length ||
      config.projects.some(p => !p.key || p.key === '*' || !p.name || (p.bootstrap && !/^\.\/[^?#]+\.json$/.test(p.bootstrap)) || (p.bootstrap && p.source)) ||
      new Set(config.projects.map(p => p.key)).size !== config.projects.length) throw Error('Invalid native configuration');
  for (const project of config.projects) {
    if (project.source) gitRemote(project);
  }
  if (config.identity && (!config.identity.name.trim() || !config.identity.email.trim())) throw Error('Invalid commit identity');
  await connect(config.projects[0]);
  return {
    csrf: '', query: '', public: false, banner: 'Browser-native Beads', banner_link: '',
    version: 'native-browser', commit: '', commit_url: '', modified: false,
  };
}
export const snapshot = (): Promise<Snapshot> => active === allProjects ? Promise.resolve(current) : readSnapshot();
export async function issue(id: string): Promise<Issue> {
  const found = current.issues.find(i => i.id === id);
  if (!found) throw new ApiError(404, 'Issue not found');
  return found;
}
export async function query(q: string): Promise<QueryResult> {
  try { return { version: current.version, ids: queryIssues(current.issues, q), error: '' }; }
  catch (error) { return { version: current.version, ids: [], error: String(error) }; }
}
export async function health(): Promise<Health> { return current.health; }
export async function reload(): Promise<Health> {
  if (readOnly) {
    if (switching) throw Error('Wait for the current project load to finish');
    switching = true;
    try {
      if (active === allProjects) await readSnapshot();
      else await connect(active);
    } finally { switching = false; }
  } else await readSnapshot();
  if (!readOnly) localRefreshError = '';
  publishLiveState();
  updateControls();
  handlers?.onEvent('changed', current.version);
  return current.health;
}
export async function projects(): Promise<ProjectList> {
  return { projects: config.projects.map((p, index) => {
    const loaded = p.key === active.key || active === allProjects;
    const issues = active === allProjects
      ? current.issues.filter(i => i.id.startsWith(`${encodeURIComponent(p.key)}::`))
      : loaded ? current.issues : [];
    return {
      slot: index + 1, key: p.key, name: p.name, location: p.key, active: p.key === active.key,
      reach: loaded ? 'local' : 'configured',
      open: issues.filter(i => i.status === 'open').length,
      in_progress: issues.filter(i => i.status === 'in_progress').length,
      ready: issues.filter(i => i.ready).length,
      blocked: issues.filter(i => i.blocked).length,
    };
  }) };
}
export async function openProject(key: string): Promise<ProjectInfo> {
  if (pending || pendingResolution || syncing || applying || switching) throw Error('Finish the pending operation before switching projects');
  const project = key === '*' ? allProjects : config.projects.find(p => p.key === key);
  if (!project) throw Error('Project is not configured');
  switching = true;
  try { if (project === allProjects) await connectAll(); else await connect(project); }
  finally { switching = false; }
  current.project = projectInfo(active, pending, pendingResolution);
  if (!readOnly) localRefreshError = '';
  publishLiveState();
  handlers?.onEvent('project', current.version);
  return current.project;
}
export async function memoryGraph(): Promise<MemoryGraphResponse> {
  return { version: current.version, available: false, reason: 'This native Beads database is not a Memory graph workspace.', loading: false, done: 0, total: 0, nodes: [], edges: [] };
}
async function savePending(): Promise<void> {
  if (!runtime) throw Error('Beads runtime has not initialized');
  await runtime.state.set('command', pending || null);
  updateControls();
}

async function applyPending(): Promise<WriteResult & { pending?: boolean }> {
  if (!runtime || !pending || !applying) throw Error('No pending request is available');
  const command = pending.command;
  feedback = 'Pending: applying changes to the local Beads database…';
  updateControls();
  try {
    const result = await runtime.request<NativeWriteResult>({ op: 'write', command });
    mergeConflicts = undefined;
    await runtime.state.set('command', null);
    pending = undefined;
    updateControls();
    feedback = active.source ? 'Succeeded locally. Use Sync with GitHub to publish.' : 'Succeeded locally. No Git repository is configured.';
    return { ...result, error: '', output: feedback, version: current.version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const receipt = await runtime.request<{ state: string }>({ op: 'receipt', command });
      if (receipt.state === 'absent') {
        await runtime.state.set('command', null);
        pending = undefined;
        updateControls();
        feedback = `Failed without applying changes: ${message}`;
        return { ok: false, ids: command.ids || [], created: '', error: message, output: '', version: current.version };
      }
    } catch { /* Preserve the request when its outcome cannot be established. */ }
    feedback = `Outcome unresolved: ${message}. Retry this same request to finish or recover its recorded result.`;
    return { ok: false, pending: true, ids: command.ids || [], created: '', error: feedback, output: '', version: current.version };
  }
}

async function withWriteLock<T>(project: Project, operation: () => Promise<T>): Promise<T> {
  if (switching) throw Error('Wait for project switching to finish');
  if (syncing) throw Error('Wait for synchronization to finish');
  if (applying) throw Error('Wait for the pending write to finish');
  applying = true;
  updateControls();
  try {
    return await navigator.locks.request(`b9s-operation:${storageName(project)}`, async () => {
      if (active !== project) throw Error('The active project changed before this request could run');
      return operation();
    });
  } finally {
    applying = false;
    updateControls();
  }
}

export async function write(req: WriteRequest): Promise<WriteResult & { pending?: boolean }> {
  const project = active;
  const expected = Object.fromEntries((req.ids || []).map(id => [id, revisions[id] || '']));
  const failed = (error: string): WriteResult => ({ ok: false, ids: req.ids || [], created: '', error, output: '', version: current.version });
  if (readOnly) return failed('This release is read-only');
  try {
    return await withWriteLock(project, async () => {
      if (active === allProjects) return failed('All projects is read-only. Open a project to edit it.');
      if (!config.identity) return failed('Configure a commit name and email to edit issues');
      pending = await runtime!.state.get<typeof pending>('command') || undefined;
      pendingResolution = await runtime!.state.get<PendingResolution>('resolution') || undefined;
      if (pendingResolution) return failed('Retry the unresolved resolution in Local changes first');
      if (pending) return failed('Resolve the pending request in Local changes first');
      pending = { project: active.key, command: {
        ...req, key: req.key || uid(), actor: config.identity.name, email: config.identity.email,
        expected,
      } };
      try { await savePending(); }
      catch { pending = undefined; return failed('Browser storage is unavailable; the request was not applied'); }
      return applyPending();
    });
  } catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
}

async function synchronize(): Promise<void> {
  if (readOnly) throw Error('This release is read-only');
  if (!runtime || syncing || applying || switching) return;
  syncing = true;
  mergeConflicts = undefined;
  updateControls();
  try {
    await navigator.locks.request(`b9s-operation:${storageName(active)}`, async () => {
      pending = await runtime!.state.get<typeof pending>('command') || undefined;
      pendingResolution = await runtime!.state.get<PendingResolution>('resolution') || undefined;
      if (pendingResolution) throw Error('Retry the unresolved resolution before synchronizing');
      if (pending) throw Error('Resolve the pending local request before synchronizing');
      if (!tokens.has(active.key)) await authenticate(active);
      await synchronizeNative({
        runtime: runtime!, remote: gitRemote(active), state: runtime!.state,
        identity: config.identity || { name: 'Browser', email: 'browser@example.invalid' },
        branch: active.source?.branch, reconcile: true,
        onStatus: message => { syncFeedback = message; updateControls(); },
      });
    });
  } catch (error) {
    if (error instanceof NativeMergeConflictError) {
      mergeConflicts = error.preview;
      conflictChoices.clear();
    }
    syncFeedback = `Synchronization stopped: ${error instanceof Error ? error.message : String(error)}. Local edits are retained.`;
  } finally {
    syncing = false;
    try {
      await readSnapshot();
      handlers?.onEvent('project', current.version);
    } catch (error) {
      syncFeedback += ` Refresh failed: ${String(error)}`;
    }
    updateControls();
  }
}

async function applyResolution(): Promise<void> {
  if (readOnly) throw Error('This release is read-only');
  if (!runtime || syncing || applying || switching) return;
  const recovering = !!pendingResolution;
  const reviewed = mergeConflicts;
  const choices: NativeResolution['choices'] = reviewed?.tables.flatMap(table => table.rows.map(row => ({
    table: table.name, id: String(row.dolt_conflict_id), side: conflictChoices.get(`${table.name}\0${row.dolt_conflict_id}`)!,
  }))) || [];
  syncing = true;
  updateControls();
  try {
    await navigator.locks.request(`b9s-operation:${storageName(active)}`, async () => {
      if (recovering) await connect(active);
      pending = await runtime!.state.get<typeof pending>('command') || undefined;
      if (pending) throw Error('Resolve the pending issue request first');
      pendingResolution = await runtime!.state.get<PendingResolution>('resolution') || undefined;
      if (recovering && !pendingResolution) {
        syncFeedback = 'No unresolved resolution remains. The local database has been refreshed.';
        return;
      }
      if (!pendingResolution && (!reviewed || !config.identity || !choices.length || choices.some(choice => !choice.side))) {
        throw Error('Choose a version for every conflicting record');
      }
      const identity = pendingResolution?.identity || config.identity!;
      const resolution: NativeResolution | undefined = pendingResolution ? undefined : { key: uid(), ours: reviewed!.ours, theirs: reviewed!.theirs, choices };
      if (resolution) pendingResolution = { identity, resolution, branch: active.source?.branch || 'main' };
      await resolveNative({
        runtime: runtime!, state: runtime!.state,
        remote: { read: async () => {
          if (!tokens.has(active.key)) await authenticate(active);
          return gitRemote(active).read();
        } },
        identity, resolution,
        branch: active.source?.branch,
        onStatus: message => { syncFeedback = message; updateControls(); },
      });
      mergeConflicts = undefined;
      conflictChoices.clear();
    });
  } catch (error) {
    syncFeedback = `Resolution stopped: ${error instanceof Error ? error.message : String(error)}`;
    mergeConflicts = undefined;
    conflictChoices.clear();
  } finally {
    syncing = false;
    try {
      pendingResolution = await runtime.state.get<PendingResolution>('resolution') || undefined;
      await readSnapshot();
      handlers?.onEvent('project', current.version);
    } catch (error) { syncFeedback += ` Refresh failed: ${String(error)}`; }
    updateControls();
  }
}

function updateControls(): void {
  const status = document.getElementById('native-feedback');
  if (status) status.textContent = pending && !applying
    ? `Unresolved request ${pending.command.key}. Retry safely using its original identity.`
    : feedback || 'Changes are stored in the local Beads database.';
  const retry = document.getElementById('native-retry') as HTMLButtonElement | null;
  if (retry) retry.disabled = !pending || applying || syncing;
  const sync = document.getElementById('native-sync') as HTMLButtonElement | null;
  if (sync) { sync.hidden = !active.source; sync.disabled = syncing || applying || !!pending || !!pendingResolution; }
  const forget = document.getElementById('native-forget') as HTMLButtonElement | null;
  if (forget) { forget.hidden = !tokens.has(active.key); forget.disabled = syncing; }
  const remoteStatus = document.getElementById('native-sync-feedback');
  if (remoteStatus) remoteStatus.textContent = active.source
    ? `${active.source.repository} · ${syncFeedback || 'Not synchronized this session.'}`
    : 'No Git repository is configured.';
  const offlineStatus = document.getElementById('native-offline-feedback');
  if (offlineStatus) offlineStatus.textContent = offlineFeedback;
  const cache = document.getElementById('native-cache') as HTMLButtonElement | null;
  if (cache) { cache.hidden = offlineReady; cache.disabled = preparingOffline; }
  renderConflicts();
  updateResolutionButton();
}

function updateResolutionButton(): void {
  const button = document.getElementById('native-resolve') as HTMLButtonElement | null;
  if (!button) return;
  button.hidden = !mergeConflicts && !pendingResolution;
  button.textContent = pendingResolution ? 'Retry reviewed resolution' : 'Apply selected versions locally';
  const count = mergeConflicts?.tables.reduce((total, table) => total + table.rows.length, 0) || 0;
  button.disabled = syncing || applying || !!pending || (!pendingResolution &&
    (!config.identity || !count || conflictChoices.size !== count || !!mergeConflicts?.tables.some(table => table.schemaConflicts)));
}

function renderConflicts(): void {
  const host = document.getElementById('native-conflicts');
  if (!host) return;
  host.replaceChildren();
  if (!mergeConflicts) {
    if (pendingResolution) host.textContent = 'A reviewed resolution has an unresolved outcome. Retry to confirm or finish those same choices.';
    return;
  }
  const heading = document.createElement('h3');
  heading.textContent = 'Conflicting changes';
  host.append(heading);
  for (const table of mergeConflicts.tables) {
    const summary = document.createElement('p');
    summary.textContent = `${table.name}: ${table.schemaConflicts ? `${table.schemaConflicts} schema conflicts` : `${table.dataConflicts} conflicting records`}`;
    host.append(summary);
    for (const row of table.rows) {
      const record = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = String(row.our_id || row.their_id || row.base_id || 'Changed record');
      record.append(title);
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Version for ${title.textContent}`);
      const key = `${table.name}\0${row.dolt_conflict_id}`;
      for (const [value, text] of [['', 'Choose a version'], ['ours', 'Keep local record'], ['theirs', 'Use remote record']]) {
        const option = document.createElement('option');
        option.value = value; option.textContent = text;
        select.append(option);
      }
      select.value = conflictChoices.get(key) || '';
      select.disabled = syncing || !!pendingResolution;
      select.onchange = () => {
        if (select.value) conflictChoices.set(key, select.value as 'ours' | 'theirs');
        else conflictChoices.delete(key);
        updateResolutionButton();
      };
      record.append(select);
      const fields = new Set(Object.keys(row).filter(key => /^(base|our|their)_/.test(key)).map(key => key.replace(/^(base|our|their)_/, '')));
      for (const field of fields) {
        if (['row_lock', 'content_hash', 'updated_at', 'diff_type'].includes(field) || row[`our_${field}`] === row[`their_${field}`]) continue;
        const label = document.createElement('h4');
        label.textContent = field.replaceAll('_', ' ');
        record.append(label);
        for (const [prefix, name] of [['base', 'Previous'], ['our', 'Local'], ['their', 'Remote']]) {
          const value = document.createElement('p');
          value.textContent = `${name}: ${row[`${prefix}_${field}`] ?? '(absent)'}`;
          record.append(value);
        }
      }
      host.append(record);
    }
  }
}

async function prepareOffline(): Promise<void> {
  if (preparingOffline) return;
  preparingOffline = true;
  offlineFeedback = 'Preparing offline files…';
  updateControls();
  try {
    if (!('serviceWorker' in navigator)) throw Error('Offline startup is unavailable in this browser');
    const registration = await navigator.serviceWorker.register('native-offline.js', { scope: './' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(Error('Offline preparation timed out')), 120000);
      const installing = registration.installing;
      const changed = () => {
        if (installing?.state === 'redundant') finish(Error('Offline files could not be cached'));
      };
      const finish = (error?: Error) => {
        clearTimeout(timer);
        installing?.removeEventListener('statechange', changed);
        if (error) reject(error);
        else resolve();
      };
      installing?.addEventListener('statechange', changed);
      navigator.serviceWorker.ready.then(() => finish(), error => finish(error));
      changed();
    });
    const activeWorker = (await navigator.serviceWorker.ready).active;
    if (!activeWorker) throw Error('Offline worker is unavailable');
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => finish(Error('Offline file verification timed out')), 120000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        channel.port1.close();
        if (error) reject(error);
        else resolve();
      };
      channel.port1.onmessage = ({ data }) => finish(data.ok ? undefined : Error(data.error || 'Offline files are unavailable'));
      activeWorker.postMessage({ op: 'prepare-offline' }, [channel.port2]);
    });
    offlineReady = true;
    offlineFeedback = 'Ready for offline use on this browser.';
  } catch (error) {
    offlineFeedback = `${error instanceof Error ? error.message : String(error)}. Local Beads data is retained; retry when connected.`;
  } finally {
    preparingOffline = false;
    updateControls();
  }
}

function mountControls(): void {
  const banner = document.getElementById('banner')!;
  banner.hidden = false;
  if (readOnly) {
    banner.classList.add('native-reader');
    const label = document.createElement('span');
    label.textContent = 'Native Beads · Read-only';
    const refresh = document.createElement('button');
    refresh.textContent = 'Refresh from GitHub';
    refresh.onclick = async () => {
      refresh.disabled = true;
      try { await reload(); }
      catch (error) {
        localRefreshError = `Refresh failed: ${String(error)}. Showing the last loaded data.`;
        publishLiveState();
      } finally { refresh.disabled = false; }
    };
    const offline = document.createElement('span');
    offline.id = 'native-offline-feedback';
    banner.replaceChildren(label, refresh, offline);
    void prepareOffline();
    return;
  }
  const label = document.createElement('span');
  label.textContent = 'Local Beads database';
  const button = document.createElement('button');
  button.textContent = 'Local changes';
  const dialog = document.createElement('dialog');
  dialog.className = 'sync-dialog';
  dialog.innerHTML = '<form method="dialog"><h2>Local changes</h2><p id="native-feedback" role="status"></p><button type="button" id="native-retry">Retry same request</button><p id="native-sync-feedback" role="status"></p><section id="native-conflicts"></section><button type="button" id="native-resolve">Apply selected versions locally</button><button type="button" id="native-sync">Sync with GitHub</button><button type="button" id="native-forget">Forget token</button><p id="native-offline-feedback" role="status"></p><button type="button" id="native-cache">Prepare offline use</button><button>Close</button></form>';
  banner.replaceChildren(label, button);
  document.body.append(dialog);
  button.onclick = () => { updateControls(); dialog.showModal(); };
  document.getElementById('native-retry')!.onclick = () => {
    void withWriteLock(active, async () => {
      await connect(active);
      await applyPending();
      await readSnapshot();
      handlers?.onEvent('project', current.version);
    }).catch(error => { feedback = String(error); updateControls(); });
  };
  document.getElementById('native-sync')!.onclick = () => { void synchronize(); };
  document.getElementById('native-resolve')!.onclick = () => { void applyResolution(); };
  document.getElementById('native-forget')!.onclick = () => { tokens.delete(active.key); updateControls(); };
  document.getElementById('native-cache')!.onclick = () => { void prepareOffline(); };
  updateControls();
  void prepareOffline();
}
function publishLiveState(): void {
  handlers?.onState(navigator.onLine && !cachedConfiguration && !localRefreshError ? 'live' : 'stale', 0);
}

export function live(h: LiveHandlers): { retryNow(): void } {
  handlers = h;
  mountControls();
  const changes = new BroadcastChannel('b9s-native-changes');
  let timer = 0;
  let running = false;
  let dirty = false;
  let reconnect = false;
  const schedule = () => {
    dirty = true;
    if (!timer && !running) timer = window.setTimeout(() => { timer = 0; void refresh(); }, 100);
  };
  const refresh = async () => {
    if (applying || syncing || switching) { schedule(); return; }
    running = true;
    dirty = false;
    const reopen = reconnect;
    reconnect = false;
    try {
      if (reopen && !readOnly && active !== allProjects) {
        switching = true;
        try { await connect(active); } finally { switching = false; }
      }
      await reload();
    } catch (error) {
      localRefreshError = `Local refresh failed: ${error instanceof Error ? error.message : String(error)}. Showing the last loaded data.`;
      publishLiveState();
    } finally {
      running = false;
      if (dirty || reconnect) schedule();
    }
  };
  changes.onmessage = ({ data }) => {
    if ((active === allProjects ? config.projects : [active]).some(project => storageName(project) === data)) schedule();
  };
  window.addEventListener('online', () => { cachedConfiguration = false; publishLiveState(); schedule(); });
  window.addEventListener('offline', publishLiveState);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  publishLiveState();
  return { retryNow() { reconnect = true; schedule(); } };
}
