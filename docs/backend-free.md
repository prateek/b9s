# Browser-native b9s

The first browser release is a read-only SPA using the pinned native Beads/Dolt engine compiled to WASM. It reads public GitHub native Dolt data without asking for tokens. The former issue-JSON snapshot adapter and Actions sync workflow are retired. JSON returned inside the UI is a projection computed by the native engine, not the storage or synchronization format.

Open the [hosted synthetic demo](https://prateek.github.io/b9s/) or download the [web-v0.1.0 release](https://github.com/prateek/b9s/releases/tag/web-v0.1.0). The hosted site uses only the public synthetic data in this fork.

## Build and configure

Use Node 24 or later, Go 1.27.2 and a C compiler. Build destinations for the runtime must be new.

```sh
npm --prefix web ci
node scripts/build-browser.mjs .b9s-e2e/native-runtime
node web/build.mjs --native --read-only --runtime .b9s-e2e/native-runtime --out .b9s-e2e/native-site
```

Create `native-config.json` in the site directory:

```json
{
  "schema": 1,
  "projects": [{
    "key": "demo",
    "name": "Synthetic Beads demo",
    "source": {
      "repository": "prateek/b9s",
      "ref": "refs/dolt/demo",
      "branch": "main"
    }
  }]
}
```

Serve the directory over HTTPS or localhost. Relative assets support project paths such as `/b9s/`. The release configuration uses synthetic data only. To read a real public source, change `repository`, Git `ref`, and native Dolt `branch`. The source must already contain native data published by `bd dolt push`. Missing branches and incompatible schemas fail visibly. The pinned bd 1.3.1 runtime requires schema 66; it does not migrate a newer database. Private sources are unsupported in this release. No credentials belong in configuration or site assets.

The application keeps the existing mobile tree, board, search, detail, dependency and project views. All projects is a combined read-only view with qualified IDs. Memory graph workspaces use a different protocol and are not supported. Ordinary native memory key/value records remain in the native database.

The read-only build disables mutations regardless of any configured identity. The browser adapter, worker RPC policy and public Git transport each reject writes. It has no token dialog, publication control or Actions dispatch. The development build without `--read-only` retains experimental write functionality for the later OAuth release; it is not the first-release artifact.

## Refresh and offline use

Refresh reads the configured Git ref, verifies native blob checksums, and opens an isolated browser database for that immutable commit. A candidate must export successfully before it replaces the selected view. No issue snapshot is imported, and no stale database is pushed back. Git metadata uses anonymous GitHub REST requests; blob downloads use immutable raw GitHub URLs without credentials. Anonymous rate limits still apply to metadata, so refreshing can fail until the limit resets.

Native data stays in IndexedDB. A verified service-worker cache supports offline startup after preparation. Failed remote reads retain the last successfully opened revision and display stale status. `/b9s/` and `/b9s/index.html` share the same storage identity. Browser storage eviction can remove offline data; the next online visit reloads it. Old revisions remain cached, so large or frequently changing repositories can consume substantial browser storage.

The compressed runtime is approximately 41 MiB and requires substantially more memory after instantiation. Chromium and WebKit are exercised at mobile viewport sizes; physical phone performance is not yet established. There is no deployed application backend. Serving public app files does not make private data readable.

## Sources and patches

`third_party/beads/v1.3.1` preserves pristine bd 1.3.1 source at `c1c4b642ac1c08d8c828007a1c2f96e47e43ef7c`, checksum, provenance, MIT license and an intentionally empty Beads patch series. Browser dependency patches and licenses live separately in `third_party/beads/browser`. Eight ordered patches and the pure-Go Zstandard replacement adapt dependencies for WASM; they do not rewrite the upstream archive. Build preparation checks each patch before application and verifies reverse application afterward. The older experiment pin remains separately identifiable and is not selected for production.

`runtime.json` records source, patch, toolchain and artifact hashes. Site builds reject stale or altered runtime inputs. The matching Go JavaScript shim is copied from the toolchain that builds the WASM engine. `web/native/go.mod` isolates these build inputs from the host b9s module; the builder compiles them within the extracted pinned Beads module.

## Reproduce validation

All fixtures are disposable local databases. Never point tests at a shared tracker.

```sh
node scripts/build-beads.mjs .b9s-e2e/native-cli
export B9S_TEST_BD="$PWD/.b9s-e2e/native-cli/bd"
node web/tests/native-fixture.mjs .b9s-e2e/native-fixture
node --test scripts/build-browser.test.mjs web/tests/git-remote.mjs web/tests/native-readonly-policy.mjs web/tests/query-parity.mjs
npm --prefix web run typecheck
node web/node_modules/playwright/cli.js install chromium webkit
node web/tests/native-readonly.mjs .b9s-e2e/native-site .b9s-e2e/native-fixture/remote.git .b9s-e2e/readonly-evidence
```

The read-only browser test uses real native Git data through a separate-origin GitHub transport fixture. It checks anonymous reads, native bd edits appearing after refresh, independent worker mutation rejection, unavailable-remote recovery, cold offline startup, canonical URL storage and screenshots in both engines. For WebKit, the harness stops the origin server instead of using Playwright's offline emulation, which rejects offline navigation before service-worker recovery. Set `B9S_LIVE_PUBLIC=1` to test anonymous CORS reads against the shipped public demo instead; this live mode does not alter GitHub data or simulate remote failure. Neither local mode establishes GitHub runner execution. Evidence for earlier writable development tests is in `experiments/browser-runtimes/README.md`; those tests are not evidence that OAuth is implemented.

The inherited Go checks remain `go build ./...`, `go vet ./...`, and `make test-stable`. On the development macOS host the stable suite requires UTC and a temporary directory outside Git, with both `TMPDIR` and `GOTMPDIR` set. Run it alone.

## Release boundaries

The product, vendored runtime, tests, release workflows, and future OAuth Worker source belong in `prateek/b9s`. Real Beads data repositories remain separately selected and authoritative. The synthetic demo uses only a dedicated ref in this fork. No upstream posting, external data-repository modification, GitHub App registration or Cloudflare deployment is part of the first release. See the [release plan](plans/2026-10-20-web-release-stages.md).

`node scripts/package-browser.mjs <runtime-directory> <new-release-directory>` creates the read-only site, synthetic public configuration, provenance/source/licenses, archive and SHA256 checksums. `web-v*` tags run the dedicated browser build workflow and do not invoke the inherited CLI/Homebrew release. The build workflow does not deploy Pages.

## Pages deployment and rollback

The separate `Browser Pages` workflow deploys an existing published browser release. It runs manually from `main` in `prateek/b9s`, downloads `b9s-web.tar.gz`, verifies the supplied SHA256, and uploads the complete site to the `github-pages` environment. Repository Pages settings must use GitHub Actions as the build source. Deployments are serialized; a documentation push does not redeploy the site.

To update or roll back, run `browser-pages.yml` with the desired published `web-v*` tag and its independently checked archive checksum. Inspect that release's `native-config.json` before deploying: only sources approved for public hosting belong on Pages. Never mix JavaScript, Go shim and WASM files from different archives. Check the deployment job, open the live page, confirm the expected issues and read-only banner, and verify refresh after rollout. Existing browser caches may continue serving the preceding version until the service worker activates; reload after it finishes preparing.
