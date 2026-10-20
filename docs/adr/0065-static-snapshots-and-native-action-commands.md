---
type: ADR
id: "0065"
title: "Serve static snapshots and apply commands through native Beads in Actions"
status: superseded
date: 2026-10-19
---

## Context

This approach was rejected for release and its browser adapter and workflow were retired. ADR 0066 and the native read-only release plan govern the browser product. The decision below records the abandoned experiment.

Prateek's fork must retain the mobile b9s UI while requiring no deployed application backend. Browser DoltLite does not share native Beads' storage format. Initial unmodified Beads/Dolt WASM builds failed; subsequent [browser runtime experiments](../../experiments/browser-runtimes/README.md) demonstrate patched Beads issue operations over DoltLite and patched full Dolt SQL/versioning directly in WASM. Those probes do not yet supply a complete persistent browser Beads backend. JSONL export cannot restore complete native state. The configured source repository and its intended visibility remain a deployment decision.

## Decision

Add a static browser adapter selected at build time. Actions builds pristine pinned Beads source with a separately ordered patch series, reads native Git-backed Dolt state, and emits versioned JSON projections. Actions and the native browser runtime use the same Beads 1.3.1 archive and schema version; the Actions runner must not migrate a shared source beyond the browser's supported version. The ordinary Go server and its API remain available under the inherited ADRs.

For static mode, ADR 0019's server-evaluated reads and ADR 0020's server pairing are replaced by relative snapshot reads and an in-memory GitHub credential. Browser commands are validated structured data dispatched to Actions; they are never shell commands or replacement database snapshots.

An isolated local Git relay carries native changes until one atomic leased Git push publishes both `refs/dolt/data` and the snapshot/receipt branch. The receipt binds a stable request identity to a canonical command digest. The base native ref is a strict optimistic concurrency precondition. No Beads storage changes are needed; the patch series starts empty.

## Consequences

- The mobile layout stays shared. Static mode has polling freshness and explicit asynchronous command feedback rather than server-sent events and optimistic changes.
- Concurrent native writes are preserved. Stale browser commands require refresh and review, including when the concurrent edit touched an unrelated issue.
- Complete authoritative state stays native. Snapshots contain issue projections only; memory graphs are outside the static export contract. The browser query adapter follows the existing Go issue-query semantics, with cross-language comparison tests.
- The source repository holds the snapshot branch with its existing visibility. Private/internal source data is never passed to Pages by these workflows.
- Source/ref/visibility verification and an explicit public Pages approval gate precede publication. No source is hard-coded.
- The local Git contracts are testable without credentials. Real GitHub execution and Pages acceptance remain separate live checks after configuration.

The [operating guide](../backend-free.md) owns configuration, retry behavior, vendoring and reproduction commands.
