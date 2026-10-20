---
type: ADR
id: "0066"
title: "Run pinned native Beads and Dolt in the client-side browser build"
status: active
date: 2026-10-20
---

## Context

Prateek requested a client-side b9s SPA that works with Git-backed native Beads without a deployed application backend. The [runtime experiments](../../experiments/browser-runtimes/README.md) established that a patched native Dolt core can run in WASM and preserve the native data format. DoltLite has a different storage format, and a browser Linux VM adds startup and transport costs. GitHub's REST API supplies the browser-accessible Git transport.

## Decision

Make the native browser build the fork's client-side path. Reuse the existing responsive UI through a browser API adapter. Compile pinned Beads issue operations and native Dolt into a worker, store native chunks in IndexedDB, and synchronize committed data through GitHub's REST API. Source repository, Git ref and Dolt branch remain configuration, with no real source assumed.

Keep pristine source archives, licenses, checksums and provenance under `third_party/beads`, separate from Go's dependency vendor tree. Apply ordered patches to a fresh build tree. Beads source changes are unnecessary for the selected operations, so its patch series stays empty. Browser dependency patches and the application adapter are separate. Actions and browser builds use the same Beads release/schema.

Native Beads validates issue operations. Each command carries an optimistic issue revision and a stable receipt identity. Native Dolt merges preserve history; record conflicts require reviewed choices tied to both heads. Merge and resolution commits include the native post-merge readiness repair. Failed or uncertain requests retain enough identity to check the receipt or prepared Git commit before retrying. Git publication is non-forced; JSON issue projections never replace the authoritative store.

The first release is built read-only and reads public data without credentials. The adapter, worker and Git transport reject mutations. An immutable Git revision gets an isolated local database and must validate before replacing the visible data. Experimental development builds retain manual in-memory credentials; write-enabled releases will replace that interface with an OAuth Worker maintained in this repository. No credential enters generated assets or persistent browser state. Native data remains in IndexedDB; the service worker caches app assets and configuration. Neither real source data nor a Pages deployment is published before the source and intended visibility are established.

This decision applies to the native static build and supersedes the retired Actions/issue-snapshot mode from [ADR 0065](0065-static-snapshots-and-native-action-commands.md). The inherited terminal and hosted browser builds retain their existing CLI, server and pairing behavior.

## Consequences

- Local reads work without an application server; the first release does not enable edits.
- Native format compatibility is tied to a pinned schema. Incompatible incoming databases are refused rather than downgraded.
- Browser storage, worker interruption and concurrent Git updates are part of the persistence boundary and require recovery tests.
- Preview Memory graph workspaces use a different protocol. The ordinary native database receives the existing capability explanation; native key/value memory data remains intact.
- Chromium/WebKit tests use synthetic repositories and native readback. Live GitHub execution, deployment and physical-device acceptance are separate from those local results.

The [operating guide](../backend-free.md) owns build, source configuration, recovery and validation instructions.
