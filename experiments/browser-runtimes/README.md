# Beads in the browser: three working probes

These experiments answer Prateek's challenge to the initial WASM assessment. **Exploring this was worthwhile: native Beads operations run over DoltLite, and the full Dolt core runs directly as WASM after a small set of dependency patches.** A browser Linux VM also runs stock native `bd` and the existing b9s web server.

The probes are separate from the [Actions-backed static app](../../docs/backend-free.md). They use synthetic issues and disposable stores. They do not select a real source repository, publish issue data, dispatch GitHub workflows, or deploy Pages.

## Results

| Route | Observed result | Remaining boundary |
| --- | --- | --- |
| Beads issueops → SQL adapter → DoltLite WASM | 23 asserted requests pass in Chromium and WebKit, including IndexedDB reloads, blocked close, dependency cycle, and stale version rejection | Partial SQL dialect adapter; no native Dolt format, history, or remote synchronization |
| Full Dolt → Go WASM | Native storage, guarded b9s writes, authenticated UI sync, browser Git publication, independent merges, and reviewed conflict resolution pass in both engines, with native bd readback | Full feature parity, broader conflict/lifecycle checks, physical devices, and live GitHub remain unverified |
| Stock Linux bd + b9s → QEMU WASM | Both engines run create/update/comments/dependencies/close/export and reopen the native store after IndexedDB save and fresh boot; Chromium also serves the b9s snapshot API | WebKit b9s startup exceeds its inherited 30-second export timeout; no browser-to-guest HTTP UI bridge |

Browsers ran headlessly on the development Mac with a 390×844 viewport. This is engine and viewport coverage, not physical iPhone testing. Timings are exploratory, with other development work running: Lite's individual requests took at most 26.3 ms in Chromium and 16 ms in WebKit in the clean reproduction; the full Dolt SQL sequence took 483 ms and 401 ms. These exclude downloading/compiling the WASM. Native VM commands generally took several seconds each; one fresh `bd init` took about 107 seconds.

## What TryNix does

[Simon Willison's link](https://simonwillison.net/2026/Sep/10/trynix/) points to [Farid Zakaria's explanation](https://fzakaria.com/2026/09/04/any-nix-package-live-in-your-browser) and [TryNix](https://github.com/fzakaria/trynix). It runs an x86-64 Linux guest under QEMU compiled to WASM, then supplies ordinary Linux binaries and their Nix dependencies. The guest uses a serial console and a 9p shared filesystem. It does not individually compile every package to WASM.

That distinction explains why native bd works there: Linux supplies its expected filesystem, process, and locking semantics. Our probe uses the deployed emulator, a pinned native bd release, Nix glibc/git, and a cross-compiled b9s binary. The guest has no network interface; its b9s HTTP API is accessed from inside the guest after enabling loopback.

After stopping b9s, the probe archives the complete native working directory, saves it to IndexedDB, starts a fresh guest, restores the archive, and compares native exports exactly. This passed in Chromium and WebKit, including comments, dependency metadata, and closed status. The browser must precreate the shared output file: creating it from the guest failed with `Operation not permitted`. This is a stopped-writer archive/reopen proof, not live transactional IndexedDB integration or crash recovery. Each final archive is about 2.3 MB.

WebKit's b9s server exited during startup: its child `bd export` exceeded the inherited 30-second limit in two sequential runs. The probe retains `b9s.passed=false` and exits nonzero even when `nativePersistence=true`; a native persistence pass does not conceal the server failure. Chromium served the expected snapshot API. An earlier WebKit run also stalled during a command; later sequential runs completed all native commands. These results do not establish reliable production VM performance. The startup investigation is recorded as `work-9at` in the isolated local task tracker; no external issue was posted.

`trynix-assets.json` records hashes of the deployed assets used, plus the inspected source commit. This is not an attestation that the deployed site was built from that commit. `mirror.mjs` serves a local cached copy, checks recorded hashes, sets the required isolation headers, disables the original isolation service worker, and exposes the emulator's filesystem to the test harness. Nix package downloads still depend on external substituters and the deployed package metadata. A changed deployment fails the asset checksum check rather than silently testing different code.

## DoltLite: actual Beads logic

`lite.go` compiles the pinned Beads `internal/issueops` routines. It does not reimplement create, update, dependency checks, or close rules in JavaScript. A Go `database/sql` driver calls DoltLite synchronously within one worker.

`schema.json` comes from native `SHOW CREATE TABLE`; `schema.go` is the extraction probe. The worker adapts MySQL DDL and the SQL exercised here to SQLite: timestamps, null-safe equality, insert-ignore, update aliases, and simple JSON field access. Unsupported JSON paths fail. `FOR UPDATE` is removed because these operations execute in a single worker under SQLite transactions; this is not a claim of multi-tab locking equivalence.

The bridge preserves 64-bit values using tagged decimal strings and BigInt. A JavaScript number would lose precision in Beads' row version and break optimistic concurrency. Tests reject stale versions, verify unchanged state after rejection, and close using the exact version. They also reject duplicate IDs, empty titles, dependency cycles, and closing a blocked issue.

The test saves the SQLite database image into IndexedDB, reloads, checks issues and comments, then creates another issue and repeats persistence. This provides useful Beads behavior over a different storage engine. It does **not** establish native Dolt file compatibility, exhaustive Beads conformance, cross-tab safety, or Git-backed native synchronization.

## Full Dolt: actual SQL and versioning

`full.go` initializes Dolt's real in-memory store and SQL engine. It creates a table, commits it, changes an issue on a branch, makes an independent main-branch edit, merges, and verifies both rows and commit history.

Eight separately stored dependency patches address OS-specific compilation boundaries. These shared production artifacts now live under `third_party/beads/browser`: `dependencies.json` pins each module and its Go checksums; `patches/series` fixes application order; `licenses/` retains upstream licenses. File locks, subprocess execution, machine identity, and network listeners fail explicitly when unsupported. They are not successful no-ops. Azure's memory mapping helper uses a heap buffer; terminal progress output uses a plain writer.

`third_party/beads/browser/gozstd/` replaces Cgo Zstandard with pinned `klauspost/compress`. Its tests decode fixtures produced by native Cgo Zstandard, including a trained dictionary, reject corruption, and exercise dictionary round trips. Dictionary **training** is explicitly unsupported, so archive compaction requiring it is not covered.

One real runtime gap remains visible: `DOLT_CHECKOUT('-b', ...)` reaches host configuration through LocalFS and panics. Separate `DOLT_BRANCH(...)` and `DOLT_CHECKOUT(...)` succeed. This probe therefore establishes a working core, not every SQL procedure or host-dependent code path. The native Beads embedded entrypoint is also Cgo build-gated; the complete CLI has not been migrated to this engine.

The generated modules are large: approximately 42 MB for the Lite Beads program and 189 MB for the full Dolt probe, uncompressed. Neither is an optimized mobile distribution.

## Native persistent storage milestone (2026-10-20)

The active goal is now a complete client-side b9s app backed by a Git repository. The following work advances that goal but does not complete it.

`web/src/native-store.mjs` implements durable blob storage and compare-and-set updates with IndexedDB transactions. `web/native/engine_js.go` connects it to Dolt's existing NBS blob-store interface; `persistent.go` is now only the probe entrypoint. It reads the native table files, archives, and manifest directly from `refs/dolt/data`, without JSONL conversion or a Linux VM. The adapter currently reads whole blobs and delegates range handling to Dolt; range-read efficiency and cancellation remain production work.

`native-fixture.mjs` creates a disposable Git-backed database using the published native bd 1.3.1. `persistent.mjs` imports its native objects into a fresh browser database, reads issues and history, reloads, performs a SQL edit and Dolt commit, reloads again, and copies the resulting native objects into a separate local Git mirror. Stock bd 1.3.1 bootstraps from that mirror and verifies the changed title, retained comment, and blocking dependency. The original fixture remote is never modified.

This complete storage round trip passes in Chromium and WebKit. The IndexedDB test also races two connections against the same manifest version and verifies exactly one conflict; seeding an existing store is rejected without adding data. Evidence lives in `.b9s-e2e/browser-runtime-repro2/results/persistent-*.json` and `.b9s-e2e/browser-runtimes/logs/persistent-release-*.log`.

The native readback exposed a version distinction: the earlier source pin uses schema v72, while published bd 1.3.1 supports v66. Schema-skew checks remain enabled. The pristine published source is additionally pinned under `third_party/beads/v1.3.1/`, with its own checksum, license, and empty patch series. Its Dolt dependency matches the successfully patched version. The browser command layer must use this release-matched Beads source before claiming default-release compatibility.

Reproduce after building `persistent.wasm` with `build.mjs`:

```sh
export B9S_TEST_BD=/absolute/path/to/native/bd-1.3.1
node experiments/browser-runtimes/native-fixture.mjs
# Use the disposable remote path printed above:
node experiments/browser-runtimes/persistent.mjs chromium /absolute/path/to/remote.git
node experiments/browser-runtimes/persistent.mjs webkit /absolute/path/to/remote.git
```

The subsequent command probe replaces the direct SQL edit with release-matched Beads `issueops`: it rejects closing the blocked issue, updates its title, and adds a comment in a transaction. Stock bd verifies the new title, two comments, open status, and retained blocking dependency after browser reload and native Git readback. Beads' own migrations initialize ignored workspace tables absent from the remote; schema-version checks remain enabled. The SQL driver uses native parameter binding and the upstream statement parser for migration batches.

This command sequence passed in Chromium and WebKit. Its source is `command-driver.go`; evidence is in `.b9s-e2e/browser-release-commands/results/` and `.b9s-e2e/browser-runtimes/logs/native-commands-*.log`. A subsequent initialization change removes the Dolt test-environment helper and creates the virtual repository directories and SQL session explicitly. Its round trip passed in both engines (`production-init-chromium4.log` and `production-init-webkit.log`); the first attempt exposed a missing virtual `.dolt/noms` directory, now created during initialization.

For the release-matched build, set `B9S_BEADS_VENDOR="$PWD/third_party/beads/v1.3.1"` when running `build.mjs` into a fresh directory, then set `B9S_RUNTIME_WORK` to that directory for the browser tests. Incrementally rebuilt binaries in the existing evidence directories do not match the original `build.json` hashes; use a fresh build for reproducibility.

The original storage tests use local Git tooling to transfer objects. The browser Git transport test below moves those operations into the browser against a local GitHub API fixture. The command probe does not establish complete CLI policy coverage. The native UI described below uses this engine. The full implementation is tracked locally as `work-4sn`.

## Reusable browser runtime

`web/native/runtime_js.go` exposes native issue export and detail requests against one live engine. Requests use Beads' hydration helpers inside SQL transactions and serialize access to the engine session. `web/src/native-worker.mjs` owns the engine and IndexedDB connection; `native-client.mjs` provides initialization, request correlation, bounded waits, error propagation, and explicit shutdown.

The extended persistence test exercises this client and worker after native edits: repeated exports, concurrent export/detail calls, comments and dependencies, unsupported-operation rejection, and rejection after shutdown. The old one-shot binary failed the request-interface test (`native-rpc-red.log`). A fresh build from the release source and ordered dependency patches passes the extended test in Chromium and WebKit. Its artifacts and matching source/binary hashes are in `.b9s-e2e/browser-native-rpc/`; logs are `.b9s-e2e/browser-runtimes/logs/native-client-clean-{chromium,webkit}.log`.

The reusable interface also exposes guarded mutations, receipt lookup, committed-data transfer, and native merge. Complete feature acceptance remains implementation work.

## Guarded native writes

`web/native/write_js.go` maps b9s create, update, comment, status, close, defer, and delete requests to Beads' native guarded operations. Issue revisions hash the hydrated row, its opaque native revision, comments, labels, and outgoing dependencies. The guard runs inside the mutation transaction. Browser Web Locks serialize workers sharing the same local database, and each request rebases the native store before starting its transaction.

Successful operations record a command digest and result under a `b9s.request.*` key in Beads' existing versioned metadata table, atomically with the operation. Replaying the original key returns its recorded result; changing the command under that key fails. If execution stops after the SQL transaction but before the Dolt commit, retry completes the commit without repeating the mutation. No upstream Beads source modification is required for this metadata extension.

The fresh `.b9s-e2e/browser-native-writes/` build passes both browser engines with native bd readback. Tests cover comment replay after worker restart, same-key/different-command rejection, stale edits, blocked closure, blank comments, two-worker contention, create replay, field edits, labels, parent edges, defer, close/reopen, and confirmed deletion that preserves dependent rows while removing their links. Native CLI comparison caught and corrected two adapter differences: defer must set `deferred` status and retain an existing date when no date is supplied; b9s confirmed deletion uses native `--force` semantics. Both corrections have failing-before/passing-after evidence (`native-defer-red.log`, `native-delete-red.log`).

Run the extended test with `B9S_NATIVE_WRITES=1` and `B9S_RUNTIME_WORK` pointing to the fresh build. Logs are `native-lifecycle-clean-{chromium,webkit}.log` under `.b9s-e2e/browser-runtimes/logs/`. The result files include native readback and command outcomes. These tests cover ordinary durable issues; ephemeral/no-history receipt behavior, crash fault injection between transaction and Dolt commit, and complete native command conformance are not yet established.

## Browser Git transport and native merge

`web/src/git-remote.mjs` reads and writes native Dolt objects through GitHub's Git database REST API, which [supports CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests). It validates blob hashes and sizes, rejects truncated or malformed trees, and supports native multipart blobs. Authentication is supplied by an in-memory token callback; credentials are not part of URLs, snapshots, or publication plans.

Publication prepares an immutable Git commit with the observed remote commit as its parent, then updates the configured reference with `force: false`. A changed remote is rejected. A lost acknowledgement is checked against the prepared commit before retrying; an unavailable readback leaves the outcome explicitly unresolved. Plans are bound to their repository and ref. Nine transport tests cover these behaviors, including malformed input, a competing write after preflight, and retry recovery after a subsequent writer advances the ref.

`web/native/sync_js.go` transfers the reachable native commit chunks rather than replacing an authoritative database from a snapshot. The outgoing transfer uses Dolt's fast-forward and working-set checks and excludes local ignored workspace data. Repeating a transfer against its result copies no additional chunks. Incoming transfer copies committed chunks, updates an application-owned tracking ref, and invokes native `DOLT_MERGE`. Fast-forward and independent-edit merges succeed; incompatible edits trigger Dolt's autocommit rollback. A conflict-resolution interface is still required.

`B9S_NATIVE_GIT=1` makes the persistence test use a second-origin GitHub API fixture backed by an isolated real Git repository. Browser code performs the Git object reads, uploads, and ref update; the fixture enforces authentication for writes and serves CORS preflights. Stock bd then bootstraps from a copy of that resulting repository and checks issue data. The test also fetches into a second browser store, merges independent edits, and rejects conflicting edits while retaining local data. `B9S_NATIVE_SYNC=1` additionally checks the committed-chunk boundary and no-op repeat.

Both engines passed browser publication and native readback (`.b9s-e2e/backend-free/native-git-{chromium,webkit}.log`) and native merge (`native-merge-{chromium,webkit}.log`). These runs incrementally rebuilt `.b9s-e2e/browser-native-writes`, so its earlier build manifest no longer describes the current binary. A subsequent fresh build in `.b9s-e2e/browser-native-git` checks and applies all eight patches and records matching source/binary hashes. Both engines pass the combined writes/Git/merge test from that build, including unchanged issue data after rejected merge and a successful subsequent local write. Logs are `native-git-clean-{chromium,webkit}.log`; the native UI regression also passes in both engines (`native-git-ui.log`). Use the fresh-build command below for reproducibility:

```sh
B9S_BEADS_VENDOR="$PWD/third_party/beads/v1.3.1" \
  node experiments/browser-runtimes/build.mjs .b9s-e2e/my-native-git-build
export B9S_RUNTIME_WORK="$PWD/.b9s-e2e/my-native-git-build"
export B9S_TEST_BD=/absolute/path/to/native/bd-1.3.1
B9S_NATIVE_WRITES=1 B9S_NATIVE_SYNC=1 B9S_NATIVE_GIT=1 \
  node experiments/browser-runtimes/persistent.mjs chromium /absolute/path/to/synthetic/remote.git
B9S_NATIVE_WRITES=1 B9S_NATIVE_SYNC=1 B9S_NATIVE_GIT=1 \
  node experiments/browser-runtimes/persistent.mjs webkit /absolute/path/to/synthetic/remote.git
node --test web/tests/git-remote.mjs
```

No authentication or repository mutation against the actual GitHub service, Actions execution, or Pages deployment has been live-tested. The app integration below now connects this transport to configuration and controls and retains prepared publications durably.

## Native b9s UI integration

`web/src/native-api.ts` connects the existing b9s screens to the worker. The native build preserves the UI and replaces its backend API calls with browser operations. It supports configuration containing named projects and an optional bootstrap file of native blobs. The test generates that file from a disposable native Git remote; it is a synthetic bootstrap mechanism, not the eventual GitHub synchronization transport.

```sh
export B9S_RUNTIME_WORK="$PWD/.b9s-e2e/browser-native-writes"
node web/tests/native-browser.mjs /absolute/path/to/synthetic/remote.git
```

This builds the native SPA and runs Chromium and WebKit at 390×844. Tree, board, search, issue details with native comments, offline indication, relative assets beneath `/b9s/`, and reopening IndexedDB after blocking the bootstrap file all pass. The extended test writes a comment through the UI, verifies blocked-close rollback and failure feedback, and restores an unresolved successful request after reload to verify safe replay without a duplicate comment. The test asserts zero application API requests and zero requests to external origins. Current evidence is `.b9s-e2e/browser-native-writes/results/native-ui.json`; `native-ui-recovery.log` records both engines' pass.

Inspected screenshots:

- [WebKit tree](../../.b9s-e2e/browser-native-rpc/screenshots/webkit-native-tree.png)
- [Chromium detail](../../.b9s-e2e/browser-native-rpc/screenshots/chromium-native-detail.png)
- [WebKit rejected write](../../.b9s-e2e/browser-native-writes/screenshots/webkit-native-rejected.png)

An optional configuration `identity` object containing `name` and `email` enables local write controls; without it projects remain read-only. This is commit attribution, not GitHub authentication. The UI persists unresolved requests in IndexedDB, exposes a safe retry control, and distinguishes definite rejection from unresolved outcome. Successful local writes explicitly report local persistence until synchronization is requested.

Projects can now specify a GitHub repository, Git data ref, and native branch; see the [native configuration example](../../docs/backend-free.md#client-side-native-build). First opening fetches native blobs through the Git API, requesting a token for private data. The Local changes dialog authenticates, synchronizes, and forgets the in-memory token. It never serializes credentials. A source's identity is part of its local database name.

`native-sync.mjs` saves the prepared Git commit before updating the ref. An unresolved attempt survives page reload and retries the exact commit before preparing new work. Its tests reject publication when the recovery journal cannot be saved, retain uncertain outcomes, stop on native merge conflicts, and avoid no-op Git commits. The native store upgrades from version 1 to version 2 without replacing blobs; the separate `state` store holds recovery data and is excluded from native blob export. Application-level Web Locks serialize writes and sync for each project, in addition to the native worker's storage lock.

The fresh `.b9s-e2e/browser-native-sync/` build and `native-sync-ui-recovery.log` establish the integrated path in Chromium and WebKit: open a configured remote, authenticate (including initial private-source access in WebKit), write through b9s, lose the publication acknowledgement and subsequent readback, reload, authenticate again, recover without another ref update, and verify the comment with stock bd. A second sync publishes nothing. [Inspected WebKit screenshot](../../.b9s-e2e/browser-native-sync/screenshots/webkit-native-synchronized.png).

The complete storage/write/Git/merge test passes from this build in both engines, including preservation of version-1 IndexedDB blobs during the journal upgrade (`native-sync-storage-{chromium,webkit}.log`). All 16 transport/coordinator tests, TypeScript checking, embedded-bundle verification, the inherited stable suite, and `go vet ./...` pass. Stable-suite output is `native-sync-stable-external.log`; its initial run used an in-worktree `GOTMPDIR` and failed the loader's explicitly outside-Git fixture requirement. The rerun sets both temporary-directory variables outside Git and skips no additional tests.

```sh
B9S_NATIVE_GIT=1 B9S_RUNTIME_WORK="$PWD/.b9s-e2e/browser-native-sync" \
  B9S_TEST_BD=/absolute/path/to/native/bd-1.3.1 \
  node web/tests/native-browser.mjs /absolute/path/to/synthetic/remote.git
node --test web/tests/git-remote.mjs web/tests/native-sync.mjs
```

The temporary query and display projection reuse the static adapter's subset and do not establish complete b9s query or native readiness parity. Memory graphs, conflict resolution controls, and full offline asset loading are incomplete. No real repository credentials or private issue data are included.

## Production runtime build

`scripts/build-browser.mjs` is the production entrypoint. It builds only `web/native` against the verified release source and patched dependencies. Engine initialization and the SQL adapter have moved into that directory; the experiment's `persistent.go` and `command-driver.go` contain only probe queries and fixture mutations. The experiment builder imports the production preparation function and emits both its probes and the production runtime, so the browser worker tests use the same production entrypoint as the SPA.

The builder emits `native.wasm.gz`, the matching `wasm_exec.js`, and `runtime.json`. The manifest records source and patch hashes, the Beads pin, dependency checksums, Go version, compressed artifact hashes, and decompressed WASM hash. `web/build.mjs --native` verifies it before copying assets. Regression tests reject tampered bytes, stale or newly added source files, probe manifests, invalid paths, and mismatched decompressed hashes. The worker also verifies the downloaded runtime before instantiation.

The fresh `.b9s-e2e/browser-production` runtime contains a roughly 41 MiB compressed asset; the 187 MiB raw build artifact is not copied into the site. Both mobile engine tests passed against that production binary, including authentication, publication recovery, native bd readback, and rejection of a configured branch that does not exist (`browser-production-branch-ui.log`). The branch setting now reaches engine initialization as well as Git synchronization.

The loader accepts both an opaque gzip asset and a response already decompressed by HTTP content encoding, verifying the corresponding recorded hash in either case. The encoded-response regression first failed checksum verification (`browser-encoding-red.log`). An intermediate Blob-based path also failed with a WebKit I/O read error; using a Response stream for compressed bytes and direct WASM instantiation for verified raw bytes passes (`browser-production-encoding-ui2.log`).

The initial two production builds differed because Go embedded absolute dependency replacement paths. Relative replacements and copying the codec into each build tree corrected that regression. Two fresh builds, `.b9s-e2e/browser-production-repro-a` and `browser-production-repro-b`, now produce identical compressed SHA-256 `38058dc045cdcc9c58167d1705a5e30d006c0479bf733cbe339fee30793949a1` (`browser-reproducibility-{red,green}.log`). This is a same-toolchain reproducibility result. Both engines pass the complete UI synchronization/recovery test using the first reproducible build (`browser-production-repro-ui.log`). [Inspected screenshot](../../.b9s-e2e/browser-production-repro-a/screenshots/webkit-native-synchronized.png).

Before the relative-path refinement, the refactored probe builder also rebuilt cleanly, and its production worker passed native storage, writes, Git transfer, merge, and stock bd readback in both engines (`browser-production-storage-{chromium,webkit}.log`). The final relative-path production build is covered by the UI/native-readback run above. All 21 build/transport/coordinator tests, TypeScript checking, the moved codec tests, the stable suite, native WASM-target vet, and root Go vet pass. Logs are under `.b9s-e2e/backend-free/`. No actual GitHub mutation or deployment was performed.

```sh
node scripts/build-browser.mjs .b9s-e2e/my-production-runtime
node web/build.mjs --native --runtime .b9s-e2e/my-production-runtime --out .b9s-e2e/my-native-site
node --test scripts/build-browser.test.mjs
```

## Cold offline startup

The production site now generates a versioned service worker with an explicit asset allowlist and checksums. Preparation verifies bytes before caching; a failed download or integrity check leaves preparation retryable. Configuration is fetched from the network with a cached fallback marked `X-B9s-Offline`. Native data remains in IndexedDB. GitHub responses, credentials, and bootstrap issue exports are outside the asset cache.

`native-offline-red.log` records the UI regression before implementation. `native-offline-origin-ui.log` records the passing Chromium/WebKit mobile flow: prepare the cache, disconnect, reload the page, read the existing database, add an offline comment, reconnect, synchronize, and verify that stock native bd reads each comment exactly once. Cache contents and the controlling worker are asserted, and no Git requests occur during the offline operation. The harness records a failed result immediately if an engine fails, rather than leaving a previous successful evidence file.

Chromium uses Playwright offline emulation. WebKit uses an actual stopped origin server: Playwright 1.63's WebKit offline emulation rejects even service-worker-only navigation, matching [upstream issue 42775](https://github.com/microsoft/playwright/issues/42775). The original emulation failure is retained in `native-offline-ui.log`; it is not counted as a pass. This server-stop check establishes cached origin independence and local writes, not physical airplane-mode behavior on an iPhone. Three service-worker contract tests additionally cover integrity failure and retry, offline configuration signaling, and cache boundaries.

The [offline WebKit screenshot](../../.b9s-e2e/browser-production-repro-a/screenshots/webkit-native-offline.png) was inspected. Service-worker upgrade behavior, storage eviction, and physical-device testing remain unverified.

## Incoming native schema compatibility

`web/tests/native-schema.mjs` clones the synthetic Git remote, uses the separately pinned newer native bd to migrate it and publish a comment, then attempts to merge those native chunks into a schema-66 browser database. The red run accepted schema 72, changed local issue data, and advanced the local head (`native-schema-red.log`, `browser-production-repro-a/schema-Guz6a7/results.json`).

The production merge path now reads the incoming commit's migration version before changing any ref or merging. A version mismatch returns an explicit error. Both Chromium and WebKit reject the upgraded remote, retain their original export and head, and successfully write a subsequent local comment (`native-schema-literal-green.log`, `browser-schema-literal/schema-3c4z8V/results.json`). Native chunks copied during inspection may remain locally as unreachable data; the rejection does not claim byte-for-byte storage identity.

The same rebuilt runtime passes the complete mobile UI flow in both engines, including compatible native merge/publication, offline reload/editing, private-source authentication, lost-acknowledgement recovery, and stock bd readback (`native-schema-ui.log`, `browser-schema-literal/results/native-ui.json`). All 24 build/transport/coordinator/offline contract tests, TypeScript checking, and WASM-target vet pass (`native-schema-contracts.log`, `native-schema-vet.log`).

An intermediate parameterized `AS OF` query triggered a nil dereference in the pinned engine's SQL planner (`native-schema-diagnostic.log`). The query now uses the native `hash.Hash` string as its literal; it does not interpolate user input. No upstream source patch was added for that unused planner path.

Reproduce using the original synthetic fixture and both pinned runtimes:

```sh
B9S_RUNTIME_WORK="$PWD/.b9s-e2e/browser-schema-literal" \
B9S_NEWER_BD="$PWD/.b9s-e2e/backend-free/pinned-native/bd" \
node web/tests/native-schema.mjs .b9s-e2e/browser-runtimes/native-release-9wHSG9/remote.git
```

Set `PLAYWRIGHT_BROWSERS_PATH` and `TMPDIR` for the local installation as needed. The newer CLI here is the retained original source pin (schema 72), not an arbitrary current binary. This check covers version compatibility; it is not a general validator for maliciously altered schema tables.

## Shared production Beads pin and fresh fixtures

The Actions CLI builder now selects the same pristine Beads 1.3.1 archive as the browser runtime. Its command planner uses that release's notes replacement/clear semantics without adding `--force`. The original schema-72 archive remains available for historical reproduction and the incompatible-schema regression.

`pin-alignment-red.log` records the failing pin-location and command-mapping tests; `pin-alignment-green.log` records all ten passing contracts. The CLI rebuilt from the shared archive at `.b9s-e2e/backend-free/native-release-aligned/bd` passes the native export/atomic-publication/retry/concurrent-writer integration, including notes replacement, clearing and refused combined-update rollback (`pin-alignment-native.log`). Both static browser engines pass with this binary (`pin-alignment-browser.log`).

`web/tests/native-fixture.mjs` creates a fresh, isolated synthetic Git repository using native bd rather than relying on an existing experiment directory. The native mobile UI flow passes in Chromium and WebKit against this newly generated source and the rebuilt CLI (`pin-alignment-native-browser.log`). The added `native-browser` CI job builds both runtimes from the pinned sources, generates that fixture, exercises the CORS test transport, and uploads only screenshots/results. Workflow lint and TypeScript checking pass. GitHub execution and Linux runner behavior remain untested; this is local macOS evidence.

## Canonical query behavior

The browser projection's query evaluator now follows the existing `ui.ParseIssueQuery` semantics: same-field alternatives, cross-field conjunction, negation, exact branch selection, bounded fuzzy matching, and source-project filtering. It also preserves the Go parser's behavior for empty values, unknown fields and literal quote characters. The native adapter no longer overwrites every issue's project with the configuration key.

`web/tests/query-parity.mjs` runs the real Go parser through a small stdin/stdout test oracle and compares its result IDs with the browser evaluator for 38 queries. Unicode casing and the UTF-8 fuzzy length bound are included. The original subset fails these comparisons (`query-parity-red.log`); the corrected evaluator and existing command/projection contracts pass all 47 tests (`query-parity-green.log`). Both CI jobs include the comparison.

The native mobile flow additionally checks alternatives, exact branch selection and fuzzy/project search. Native and Actions/static flows pass in Chromium and WebKit (`query-native-browser.log`, `query-static-browser.log`), including their existing write, recovery and native-readback checks. TypeScript, workflow lint, the stable suite and root Go vet pass (`query-parity-stable.log`, `query-parity-vet.log`). Memory graphs, merge-conflict controls and remaining projection/lifecycle cases are still incomplete.

## Native merge conflict review

The runtime now exposes a non-mutating merge preview using Dolt's own conflict-summary and conflict-row table functions. It returns the local/remote commit hashes and base/local/remote records. Browser synchronization runs this before the merge; conflicts return a structured error, and the Local changes dialog shows the competing values. No Git objects are uploaded on this path. Reviewed record choices can then be applied locally as described below.

`conflict-preview-red.log` records the missing runtime operation. The native test creates two independent browser databases from the same native source and changes the same issue on both sides. Chromium and WebKit preview the actual conflict while retaining their original local head and issue export. `conflict-integer-red.log` records the precision regression: native 64-bit row identifiers arrived as JavaScript numbers. They now travel as decimal strings; the preview never needs to reconstruct authoritative rows from rounded JSON values.

The complete UI test creates a competing remote edit through the real native Actions runner, then checks the displayed previous/local/remote titles and verifies that synchronization makes no POST/PATCH requests. Both engines pass (`conflict-review-ui.log`, `browser-conflict-review/results/native-ui.json`). The log includes harmless fixture-directory permission warnings from the earlier runner; the runner now creates `.beads` with mode 0700. [Inspected screenshot](../../.b9s-e2e/browser-conflict-review/screenshots/webkit-native-conflicts.png).

All 73 build, transport, coordinator, offline, query and command contracts pass (`conflict-review-contracts.log`), along with TypeScript, WASM-target vet and the stable suite (`conflict-review-vet.log`, `conflict-review-stable.log`). Both engines still reject incompatible incoming schemas (`conflict-review-schema.log`). A fresh native readback workspace at `.b9s-e2e/backend-free/permissions-MBeXxi` verified the corrected 0700 mode.

The Memory investigation found a protocol distinction, not missing native issue-table relationships. b9s's optional graph view uses the preview Memory protocol; the pinned native release's `memoryops` stores `bd remember` values in `kv.memory.*` configuration rows. The ordinary native workspace now receives the same kind of capability explanation as hosted b9s (ADRs 0043/0044), without invented nodes. The fresh native fixture contains a remembered value, and both browser publication tests verify it through stock `bd recall`. Preview graph workspaces remain unsupported by this runtime.

## Reviewed conflict resolution and recovery

The production runtime applies a local/remote choice for every native conflict in one SQL transaction, using authoritative native rows rather than reconstructing them from the preview JSON. It checks both reviewed heads, rejects incomplete choices and schema conflicts, and commits a receipt with the resolved merge. Retrying the same request returns its recorded result; reusing the key with different choices fails.

`conflict-resolution-ui.log` and `.b9s-e2e/browser-resolution-ui/results/native-ui.json` record passing Chromium and WebKit runs. Both engines retain independent comments, preserve the selected native revision exactly, and replay the receipt after reopening the worker without advancing the merge head. The mobile UI test deliberately discards the successful resolution reply and terminates the worker. After reload, retry recovers the receipt without issuing another resolution call. Explicit synchronization then publishes the result, which the pinned native bd reads back. All 14 sync coordinator contracts and TypeScript checking also pass.

This proves the exercised issue-update conflict and lost-reply paths. Deletion conflicts, broader multi-record rollback, physical devices and live GitHub still need acceptance evidence. Schema conflicts are deliberately refused.

## Native branch isolation

The expanded fixture publishes `main` and `browser-review` through the pinned native Dolt library. The embedded bd CLI creates issues but does not expose arbitrary SQL or non-main remote publication, so `web/tests/native-fixture/main.go` supplies only that test setup operation. The fixture script copies this helper into the extracted native build tree and uses its module dependencies; it does not modify the pristine vendor archive.

The first browser run failed opening the valid remote branch because it had no local working set (`branch-red.log`). The runtime now creates a missing working set from that branch's committed head, preserving existing working sets. A separate failing test demonstrated that a request naming another branch reached the remote operation instead of being rejected (`branch-guard-red.log`). Runtime requests now enforce the configured branch before any mutation, and client defaults inherit that same branch.

Chromium and WebKit pass the expanded native suite (`branch-green.log`, `.b9s-e2e/browser-branches/results/native-ui.json`). The test edits and merges independent records on `browser-review`, reopens the resulting native data, and verifies that both records on `main` remain unchanged. It also runs both conflict choices, receipt lookup, retry and worker-reopen recovery on the non-main branch. The existing mobile UI, offline, lost-response and native bd readback checks remain green. WASM-target vet, TypeScript and the fresh native fixture generator pass locally. Live GitHub and physical devices remain untested.

## Deletion conflicts and failed resolution commits

`web/tests/native-resolution.mjs` exercises both local and remote deletion against a competing update, choosing either version in each direction. It also resolves two issue conflicts with different choices, injects a failed IndexedDB manifest write at the native commit boundary, and checks rollback. The injected failure occurs only when the manifest's root changes, after remote chunk staging; the test requires an error from the reviewed-merge commit.

The first run exposed an error-conversion bug: JavaScript errors crossed into Go as `<object>` (`resolution-edges.log`). The browser storage adapter now preserves the JavaScript error text. Both focused browser runs pass (`resolution-edges-focused.log`, `.b9s-e2e/resolution-edges-focused/results/native-ui.json`): the failed commit retains the original head and both local issue titles, records no success receipt, and can be retried after reopening the worker. Repeating the successful retry does not advance the merge head again.

The fault worker exists only in the test site's generated assets. Production builds contain no fault operation. `B9S_NATIVE_CASE=resolution` selects this focused test; the default native browser run includes it with the rest of the UI flow. `B9S_NATIVE_EVIDENCE` selects a separate evidence directory so a new run does not replace a previous runtime's results.

Choosing an issue record follows native table-level merge semantics. Separately deleted, non-conflicting comments and dependencies remain deleted when the issue row is restored. This investigation identified the missing native `is_blocked` repair hook, addressed below.

Epic summary projection now matches `ui.FirstSentence`, including headings, list markers, paragraph boundaries, Unicode whitespace and retained sentence punctuation. Eleven of twelve comparisons against the actual Go function failed before the fix (`summary-parity-native-red.log`); all twelve pass afterward (`summary-parity-green.log`). The earlier `summary-parity-red.log` caught an incorrectly initialized test oracle and is not regression evidence for the implementation.

The full native UI flow passes in both engines with these cases included (`resolution-edges-full.log`, `.b9s-e2e/resolution-edges-full/results/native-ui.json`). All 91 build/transport/coordinator/offline/query/projection contracts, TypeScript, WASM-target vet, the stable suite and both Actions/snapshot browser runs pass (`resolution-edges-contracts.log`, `resolution-edges-wasm-vet.log`, `resolution-edges-stable.log`, `resolution-edges-static.log`). These remain local synthetic tests; no GitHub workflow or deployment was executed.

## Native readiness after merging

`web/tests/native-readiness.mjs` found stale persisted `is_blocked` values after two merges: a local child inherited a blocker that the remote closed, and a resolved issue retained its old blocked flag after the merge removed its dependency. `readiness-red.log` records the failing assertion; `.b9s-e2e/readiness-red/readiness-native-blfidF/results.json` records both stale values. The inspector reads `issues AS OF 'HEAD'` through the pinned native Go library, directly from browser-produced native chunks. It does not run Beads bootstrap, pull or a repair first.

The browser now calls native `RecomputeIsBlockedAfterMergeInTx` before committing either a clean merge or a reviewed resolution. Clean merges defer their commit until repair succeeds, refuse an already-dirty working set, and avoid an extra commit when repeated synchronization changes nothing. The resolution receipt shares the repaired merge's commit.

Chromium and WebKit pass the focused readiness checks (`readiness-focused.log`, `.b9s-e2e/readiness-focused/results/native-ui.json`). Both stale values are corrected in committed native data. A failed manifest write during a clean merge retains the old head; reopening and retrying repairs the data, and replay creates no additional commit. The full suite also includes a fast-forward case and repeated-merge assertions. The front page, architecture and ADR 0066 now describe the native client-side path; ADR 0065 continues to describe the separate Actions/snapshot build.

The full suite passes in Chromium and WebKit (`readiness-full.log`, `.b9s-e2e/readiness-full/results/native-ui.json`), including native readback of clean, resolved and fast-forward merges, the earlier deletion/rollback cases, non-main branches, offline use and publication recovery. All 91 contracts, TypeScript, WASM-target vet and the stable suite pass (`readiness-contracts.log`, `readiness-wasm-vet.log`, `readiness-stable.log`). Deployment and live GitHub execution remain outside this local evidence.

## Native project switching

The adapter now validates the candidate database's journals and first export before replacing the active runtime. Failed opens retain the previous project. Concurrent switches and edits during a switch are rejected, and late reads from an obsolete runtime return the current snapshot.

The focused regression failed before the fix with the active project changed from `alpha` to `beta` after an injected journal failure (`.b9s-e2e/backend-free/projects-red.log`). The focused tests pass in Chromium and WebKit (`projects-focused.log`), covering journal and export failures, database isolation, overlapping operations, and obsolete reads. The complete native suite also passes in both engines (`projects-full.log`, `.b9s-e2e/projects-full/results/native-ui.json`), including native CLI readback, merge recovery, and zero application-backend requests.

Mobile pointer tests also pass in both engines: switch to a second database, try an unavailable project, retain the visible project and rows with an explicit error, then return to the first database (`projects-mobile.log`). Inspected screenshots show the retained project and HTTP 404 feedback:

- [Chromium project failure](../../.b9s-e2e/projects-mobile/screenshots/chromium-project-failure.png)
- [WebKit project failure](../../.b9s-e2e/projects-mobile/screenshots/webkit-project-failure.png)

TypeScript, the web build, whitespace checks, and the stable Go suite pass (`.b9s-e2e/backend-free/projects-stable.log`).

These are disposable local repositories and synthetic credentials. Live GitHub execution, deployment, and physical phones remain untested.

## Native combined projects

The native adapter supports the existing read-only **All projects** view. It reads configured databases sequentially and releases each temporary worker. Project-qualified issue and dependency IDs preserve separate records even when repositories contain identical native IDs. Queries and details use those qualified IDs; writes are refused until an individual project is selected. Any failed source aborts the switch and identifies the project, preserving the previous view.

The regression first failed with `Project is not configured` (`.b9s-e2e/backend-free/all-projects-red.log`). Chromium and WebKit then passed the adapter checks for duplicate IDs, dependency isolation, project queries, detail reads, read-only writes, and failed-source preservation (`all-projects-green.log`). A separate race regression demonstrated that an old aggregate read could replace a newer one after switching away and back (`all-projects-epoch-red.log`). Successful selections now advance a counter so obsolete reads cannot publish their results.

The mobile combined-view check initially timed out in WebKit when the test used Playwright routing to restore the missing fixture after service-worker activation (`all-projects-full.log`); Chromium passed that run. The fixture now restores the resource at the HTTP server instead. Both browsers open the combined view with this real response. Inspected screenshots show three project groups, six separate issues, and a read-only header:

- [Chromium all projects](../../.b9s-e2e/all-projects-full2/screenshots/chromium-all-projects.png)
- [WebKit all projects](../../.b9s-e2e/all-projects-full2/screenshots/webkit-all-projects.png)

The full native suite passes in both engines (`.b9s-e2e/backend-free/all-projects-full2.log`, `.b9s-e2e/all-projects-full2/results/native-ui.json`), including the obsolete-read regression, mobile combined view, offline edits, synchronization, reviewed resolution, interrupted-operation recovery, and native CLI readback. Each engine records zero application-backend requests. TypeScript, the web build, and 81 runtime-build/transport/coordinator/offline/query contracts pass (`all-projects-contracts.log`). No live GitHub operation or deployment was performed.

The stable Go suite and whitespace checks also pass (`.b9s-e2e/backend-free/all-projects-stable.log`).

## Local freshness and aggregate reads

A regression counted nine native runtime initializations for one combined-view open and two snapshot reads (`.b9s-e2e/backend-free/aggregate-cache-red.log`). The adapter now reuses the loaded aggregate until refresh, initializing each of the three test databases once. Project-list counts come from each database's qualified rows. Chromium and WebKit pass these checks (`aggregate-cache-green.log`).

The two-tab regression timed out before storage notifications existed (`freshness-red.log`). Native storage now broadcasts committed manifest and journal changes, and the browser adapter refreshes affected projects. Both engines pass single-project and combined-view update checks without manually refreshing the observer (`freshness-green.log`). Visibility changes also request a local refresh; remote Git synchronization remains explicit.

A separate regression proved that project switching could proceed while a write was reading its journal (`write-preparation-red.log`). The write reservation now covers preparation, the cross-tab lock, command application, and recovery. Refreshes cannot replace the recovery state of an in-flight write.

The full native suite passes in Chromium and WebKit (`.b9s-e2e/backend-free/freshness-full.log`, `.b9s-e2e/freshness-full/results/native-ui.json`). It includes the preparation guard, aggregate cache/counts, cross-tab updates, an injected refresh failure that retains displayed data, and explicit retry after the observer's worker exits. Two actual mobile app pages also exchange a comment through the local database without manually reloading the observer. Both engines still pass offline edits, publication and resolution recovery, and native bd readback, with zero application-backend requests.

Inspected mobile observer screenshots:

- [Chromium cross-tab freshness](../../.b9s-e2e/freshness-full/screenshots/chromium-native-cross-tab.png)
- [WebKit cross-tab freshness](../../.b9s-e2e/freshness-full/screenshots/webkit-native-cross-tab.png)

TypeScript, the web build, all 91 contracts (`freshness-contracts.log`), the stable Go suite (`freshness-stable.log`), and whitespace checks pass. This remains local synthetic evidence; no live GitHub mutation or deployment was performed. The completion audit still needs to reconcile full command coverage with the original acceptance requirements.

## Production command coverage and standalone preview

The production acceptance run now includes the mutation contract previously exercised only by the experiment harness. Both Chromium and WebKit pass (`.b9s-e2e/acceptance-full/results/native-ui.json`). Coverage includes every allowed create/update field, parent relationships, labels, comments, defer/close/reopen/delete, atomic bulk status/close/delete, blocked-close rollback, stale revisions, duplicate request identities, restart recovery and concurrent writers. Published native chunks are read by the pinned native bd CLI in a separate disposable Git repository; the assertions compare the retained fields and dependencies.

The mobile UI separately passes create, edit, defer, close with a comment, reopen and delete. This runs alongside project isolation, combined reads, local cross-tab refresh, offline reload/edit, Git publication recovery, conflict resolution and native readback. Both engines report zero application-backend requests. The GitHub API used here is a separate-origin local fixture, not github.com.

The standalone build at `.b9s-e2e/standalone-preview` contains only synthetic bootstrap data. `web/tests/native-preview.mjs` serves the packaged files without changing their configuration or supplying any Git API. Both engines pass loading, adding a comment and retaining it after reload (`.b9s-e2e/standalone-preview-evidence/results.json`). Reproduction commands are in `docs/backend-free.md`. The mobile screenshots were inspected:

- [Chromium standalone preview](../../.b9s-e2e/standalone-preview-evidence/chromium.png)
- [WebKit standalone preview](../../.b9s-e2e/standalone-preview-evidence/webkit.png)

The workflow includes this standalone smoke test and the expanded production suite. Actionlint passes locally; the workflow has not run on GitHub. Source visibility validation rejects a private source in a public workflow repository. Sync requires explicit configuration, and Pages additionally requires public-source visibility and explicit deployment approval. Neither deployment nor private-data publication was performed.

Final local gates pass: all 91 JavaScript contracts, TypeScript checking, `go build ./...`, `go vet ./...`, the isolated `make test-stable` run, actionlint and tracked-diff whitespace checks. Logs are `.b9s-e2e/backend-free/handoff-{contracts,types,build,vet,stable}.log`.

Acceptance evidence by requirement:

| Requirement | Evidence |
| --- | --- |
| Fork and isolated worktree | `origin` is `prateek/b9s`, `upstream` is `vanderheijden86/b9s`; branch `prateek/backend-free` starts at origin/main `793407bd86c74ba9985c9870c39392974ec8380e`. |
| Existing mobile UI with no app server | Production `acceptance-full` and standalone preview pass in Chromium/WebKit with zero application-backend requests. |
| Native Beads authority and Git storage | Production mutation and sync tests publish native chunks, then bootstrap/pull/read with pinned native bd. JSON is a projection, not the synchronization format. |
| Validated writes, concurrency and recovery | Production mutation, project, conflict and resolution cases cover revisions, receipts, rollback, isolation, publication loss and reload. |
| Actions alternative and JSON adapter | `browser-runtimes/logs/native-contracts-isolated2.log` and `static-browser-isolated.log` cover local CLI application, refreshed projections, dispatch/retry feedback and nested paths. |
| Pristine sources and reproducible patches | Separate `third_party/beads` archives/provenance/licenses and ordered dependency patches; production runtime manifest validates source/recipe/artifact hashes during packaging. Clean-build evidence is recorded below. |
| Configuration and privacy | `docs/backend-free.md`, synthetic fixture builder, in-memory credentials, disabled-by-default sync, source visibility checks and separate Pages approval gates. |
| Reproducible visible handoff | Standalone artifact, smoke-test script, inspected screenshots above and documented build commands. |

No root commit, push, external posting or deployment was performed. Selecting the real source repository, establishing its intended visibility and testing that installation's authentication/publication remain operator setup steps; they were deliberately not inferred from the synthetic fixtures.

## Live GitHub round trip in Orca

At Prateek's request, a private temporary repository, `prateek/b9s-browser-test-20261020`, was created with synthetic native Beads data. Orca 1.4.229 used a dedicated isolated browser profile and the production static build at `http://127.0.0.1:59421/b9s/`. The server served files only; all data operations went directly to `api.github.com`.

The existing GitHub CLI credential for `prateek` was entered through the browser skill's stdin-only helper. This was the CLI's OAuth token with repository access, not a newly issued fine-grained token. It was never included in assets, command arguments or evidence files.

Verified:

- Unauthenticated access to the private data ref returned 404; authentication loaded the native fixture.
- Creating `browser-e6p` through the UI and choosing **Sync with GitHub** published commit `5b52b1f72ed95413d688ef02341e1cacc1eb26e7` to `refs/dolt/data`.
- A fresh Git mirror and isolated native bd bootstrap/pull/export read the created issue, description and labels (`.b9s-e2e/orca-live-readback/result.json`).
- Native bd changed the title to “Native bd returned to Orca” and added “Round trip confirmed by native bd.” Its non-forced push advanced the remote to `5877631f25ecbacd8a92cc4b4d0c7edb2e55401d`. Orca's next sync displayed both changes.
- Reload preserved the issue and comment. A subsequent sync requested a token again, confirming the credential did not survive reload.
- Browser resource evidence records 41 direct GitHub requests and zero application-backend requests (`.b9s-e2e/orca-live-network.json`).

Inspected screenshots:

- [Orca publication](../../.b9s-e2e/orca-live-published.png)
- [Orca native round trip](../../.b9s-e2e/orca-live-return.png)

The Orca text waiter hung while the background tree rows were not text-rendered; its task-owned read-only helper was stopped, and subsequent snapshots and page-scoped DOM interactions verified the same tab without replaying login. This live test used background DOM form/keyboard events, not foreground pointer automation. It does not extend the fixture-based concurrency/conflict checks to live GitHub, nor establish GitHub Actions, Pages, fine-grained-token restrictions or physical-device acceptance. The temporary repository and isolated profile are retained because deletion was not authorized.

## Provenance and reproduction

Run from the repository root. Install the web test dependencies using the existing web lockfile and Playwright Chromium/WebKit. Use a writable temporary directory on a volume with sufficient space. The following builds require Go, Node, npm, git, and tar:

```sh
node experiments/browser-runtimes/build.mjs .b9s-e2e/my-browser-build
export B9S_RUNTIME_WORK="$PWD/.b9s-e2e/my-browser-build"
node experiments/browser-runtimes/lite.mjs chromium
node experiments/browser-runtimes/lite.mjs webkit
node experiments/browser-runtimes/full.mjs chromium
node experiments/browser-runtimes/full.mjs webkit
go -C third_party/beads/browser/gozstd test ./...

node experiments/browser-runtimes/setup-vm.mjs
node experiments/browser-runtimes/vm.mjs chromium
node experiments/browser-runtimes/vm.mjs webkit
```

Set `PLAYWRIGHT_BROWSERS_PATH` if the browser installation uses a custom location. The VM defaults to initializing a fresh native database inside the guest; `B9S_VM_SEED=1` instead requires an empty native 1.3.1 store archived as `$B9S_RUNTIME_WORK/seed.tar`. Final Chromium repetition used this faster seed route; guest initialization was separately exercised successfully.

The build refuses an existing target directory. It verifies the selected pristine Beads archive (now defaulting to `third_party/beads/v1.3.1/provenance.json`), extracts it into the build directory, verifies dependency module checksums, and checks/applies/reverse-checks each patch inside its own temporary Git repository. Original upstream source is never patched in place. The Beads source patch series remains empty. The shared dependency patches are used by production browser and experiment builds; the native Actions binary does not require them.

The initial Beads source pin was `1fcd715e7545c35a38802d45ba66fa56b5352824`; it remains retained separately. Current browser builds default to published **1.3.1**, `c1c4b642ac1c08d8c828007a1c2f96e47e43ef7c`, matching the native readback binary. DoltLite package: `@dolthub/doltlite-wasm@0.51.1`. The VM also uses the stock **1.3.1** Linux release; `setup-vm.mjs` verifies its release archive SHA-256. b9s is compiled from this worktree. Its native Go server required no runtime port for Linux.

The successful clean rebuild is `.b9s-e2e/browser-runtime-repro2/`: `build.json` records WASM hashes and pins; `results/` contains both engines' JSON evidence, SQL traces, and screenshots. VM logs/results are under `.b9s-e2e/browser-runtimes/`. `logs/vm-chromium13.log` records the complete Chromium pass; `logs/vm-webkit3.log` records the WebKit native persistence pass and b9s failure. The separately preserved `results/vm-webkit-stall.json` records the earlier stall and termination of only the task-owned processes. No full VM WebKit pass is claimed.

The production vendoring script also received a regression fix discovered during this work: patch application now has an independent Git root and a reverse-application check. A synthetic patch test failed before the fix and passed afterward. Native runner isolation explicitly sets `BEADS_DIR` and creates local embedded-storage metadata without a project identity before bootstrap; the latter prevents upstream's deliberate ancestor-config fallback. Its integration fixture includes conflicting ancestor metadata to prevent accidental parent discovery.

Validation also passed for the rebuilt production native binary, all ten command/vendoring unit tests, the native publication/retry/concurrent-writer integration test, and the static app's Chromium/WebKit browser flow using that binary. Logs are `logs/native-build-root2.log`, `logs/native-contracts-isolated2.log`, and `logs/static-browser-isolated.log` beneath the VM evidence directory. The VM setup script was separately executed successfully into `.b9s-e2e/browser-vm-setup-check/`. JavaScript syntax, Go formatting, and tracked-diff whitespace checks passed. The native codec tests passed independently. This adds to the earlier static-app validation; it does not claim GitHub execution, Pages deployment, or physical-phone acceptance.

Inspected screenshots from this worktree:

- [DoltLite WebKit](../../.b9s-e2e/browser-runtime-repro2/results/lite-webkit.png)
- [Full Dolt Chromium](../../.b9s-e2e/browser-runtime-repro2/results/full-chromium.png)
- [VM Chromium](../../.b9s-e2e/browser-runtimes/results/vm-chromium.png)

## Interpretation

The earlier blanket conclusion that full Dolt cannot run as WASM was too strong. Unmodified builds fail, but a patched core demonstrably works. Native-format persistent storage, release-matched Beads operations, native bd readback, authenticated browser Git synchronization and reviewed record conflict resolution now work through the b9s UI. The production suite covers the browser command contract and mobile lifecycle. Live GitHub authentication and bidirectional publication have additionally passed in Orca as described above. GitHub-hosted Actions execution, Pages deployment and physical devices remain untested.

The VM proves that native compatibility is possible immediately, at a substantial startup and execution cost. It is not yet a polished b9s browser application: the API test happens inside Linux, and browser UI transport, authentication, synchronization, and mobile reliability remain work for that alternative. The production SPA uses the patched native WASM engine directly. The Actions app remains a separate implementation.

## Local isolation incident

An early native initialization discovered the parent worktree because its scratch directory lacked its own Git repository. It changed parent-local Beads metadata, generated agent files, and staged tracker configuration. No commit, push, or shared tracker write occurred. The captured tracked changes were reversed, and the newly created files/database were moved into `.b9s-e2e/browser-runtimes/accidental-init/` without deleting them.

The ignored metadata's database name was restored to the existing `beads` store. Its original bytes were not captured, so exact restoration of ignored metadata cannot be claimed; a generated project identifier remains. Subsequent native fixtures used isolated Git repositories and explicit environment paths. The existing issue database showed no evidence of mutation. The captured patches and relocated files remain available for inspection.
