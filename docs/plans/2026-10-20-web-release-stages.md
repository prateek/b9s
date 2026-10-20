---
status: active
doc_type: plan
summary: "Ship native read-only Beads in a token-free browser SPA, then add OAuth-backed writes."
owner: Prateek
created: 2026-10-20
related:
  - ../backend-free.md
  - ../adr/0066-run-native-beads-in-the-browser.md
---

# Browser release stages

Prateek rejected the issue-JSON snapshot proposal. The first release runs the native Beads/Dolt WASM engine, reads public GitHub data using CORS without user tokens, and enforces read-only capabilities at build time. The second release adds OAuth through a Cloudflare Worker whose source stays in this repository.

## Boundaries

| Boundary | Responsibility |
| --- | --- |
| `prateek/b9s` | Product UI, native runtime adapter, pristine vendored sources and patches, tests, release artifacts, future Worker source |
| Configured Beads data repository | Authoritative native Dolt data under a configured Git ref and Dolt branch; normal native bd workflow |
| `prateek/b9s` synthetic demo ref | Public fabricated data for the first release; no real issues or credentials |
| `vanderheijden86/b9s` | Upstream shared UI and host application; fixes can be proposed later with explicit authorization |
| `gastownhall/beads` and dependency upstreams | Native semantics and storage; independently reviewable portability fixes |
| Future GitHub App and Cloudflare deployment | OAuth registration, secret bindings and callback policy; no separate source repository required |

This release is authorized only within `prateek/b9s`. Do not mutate other repositories or services without discussing it with Prateek. Keep real data source selection independent of product publication. Do not copy private test data into release assets.

## First release

Build with `--native --read-only`. Identity configuration cannot enable edits. The API adapter, worker and public Git transport reject mutation requests. Native Git revisions are fetched without credentials, checksummed and opened locally; failed refreshes preserve the last readable view with stale feedback. The existing mobile navigation, search, details, dependencies, board and projects remain available.

Publish browser artifacts with `web-v*` tags, separate from the inherited CLI `v*` release and Homebrew automation. Include runtime provenance, source and dependency licenses, reproducible build instructions and artifact checksums. Validate the exact release build in Chromium and WebKit, relative deployment paths, anonymous Git reads, write rejection, unavailable-remote behavior, schema rejection and clean patch application. Distinguish local fixture acceptance, live GitHub CORS, Actions execution and Pages deployment in release notes.

## Write-enabled release

Keep the current development write path out of v1. Replace manual token entry with a Worker-mediated OAuth flow in this repo. The Worker owns OAuth state/callback validation and credential exchange, not Beads storage or a JSON issue API. Design token scope, lifetime, revocation and trusted origins before deploying. Private source access requires explicit authenticated data handling and cache policy.

Preserve native guarded writes, durable operation identities, conflict previews, reviewed resolutions and uncertain-publication recovery. Fix the reviewed stale-form revision race before enabling edits: a command must carry the revision the user actually reviewed, not the latest background revision. Exercise two-tab edits, skewed schemas, concurrent writers, lost replies and native bd readback. An OAuth redirect succeeding is not proof that those contracts hold.

Upstream contributions and external service provisioning are separate actions requiring discussion. No new repository is necessary for the product or Worker source.
