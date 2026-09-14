# Docker gate investigation — 2026-09-14

## Scope and environment

Investigated clean revision `474f7f3d9310761008acf10775a3a6960d5664bf` on `main`.
The local isolated Docker container uses the upstream pinned Node **24.21.0**
Bookworm slim image, Linux **ARM64**, and dependencies installed with `npm ci`.
The Docker VM has two CPUs and approximately 4 GiB RAM. No live service, library
mount, credential, or database was used or changed.

The operator can ask Hermes to perform the final **native Linux amd64** upstream
Docker build on RRserver. ARM64 results below do not establish native-amd64 acceptance.

## Findings

### Selected-profile badge

The reported assertion is the final check after a catalog event, not the initial
connection check. The event immediately downgrades comparison evidence, then
debounces its refresh for 180 ms. The match-index mock being called does not mean
reconciliation has finished: token hashing and publication still follow it. The
assertion's `vi.waitFor` uses its unchanged default deadline.

The original test passes individually, with the other two tests, in the complete
controller file, and in the full ARM64 gate. No stale selector, navigation change,
or deterministic cross-profile matching defect was reproduced. The exact
RRserver `undefined` badge assertion has **not** been reproduced locally. An
assertion observing the legitimate in-progress downgrade under load remains an
explanation to verify on RRserver, not a proven native-amd64 root cause.

### Duplicate Send and cross-device isolation

Both original tests complete normally on ARM64; neither mock path contains a
duplicate-dependent retry loop or an uncompleted device operation. Two copies
with the same strong managed token remain confirmed. Clearing raw inventory at
connect/disconnect and checking the current device epoch prevents Kindle A from
becoming Kindle B's live inventory after B's failed scan.

There is a measurable real-AppView rendering bottleneck in the controller/jsdom
test harness: the three original tests invoke 39, 43, and 44 full render calls,
respectively. An observational
wrapper measured 2,911/3,182 ms, 2,779/2,869 ms, and 2,840/3,093 ms inside rendering
(91–97% of test runtime). Respectively 21, 19, and 24 calls left identical markup.
Publishing one comparison separately set statuses, set inventory, and committed
readiness, rebuilding the DOM repeatedly and starting two overlapping catalog
reloads. Reconciliation also recommitted an already-loading AppState.

A separate controlled experiment limited only the isolated container to 0.6 CPU.
All three original tests exceeded their unchanged five-second deadline, including
the two reported timeout cases. This demonstrates timing sensitivity; it does
**not** establish RRserver's CPU allocation or prove its exact failure cause.
The initial batching fix made duplicate Send pass under that constraint; the
other two still timed out. Adding the no-op commit guard did not make that
deliberately constrained run universally pass either. No timeout was increased
to hide that result. Normal validation restores a verified two-CPU budget.

### Test-order and cleanup audit

The harness leaves window listeners attached, and a UI click launches Send
without awaiting its controller promise. These are real cleanup/synchronization
leads, but no causal test-order failure was established. Baseline full-file and
full-suite runs pass. They are not bundled into a broader disposal/session API
change, and the original three tests and assertions remain intact.

## Focused change

1. Add synchronous, nested, exception-safe catalog publication batches. State
   changes immediately; render requests merge and Kindle-driven reload requests
   coalesce to one final-state query when the outermost call returns.
2. Batch AppView publication with the controller's comparison result, unmatched
   inventory result, and verified-transfer fallback. No timers or awaits are
   introduced and no authority check is deferred.
3. Skip shallow-identical controller commits after existing progress-observer
   invalidation. Catalog-only changes still repaint even with the same AppState.

Tests were added first and observed failing before implementation. New coverage
checks one DOM replacement, one final-membership reload, duplicate-copy counts,
Possible fallback, event-stream loss, last-seen/disconnect retirement, unchanged
AppState with changed catalog data, no-op commits, nested batches, callback and
renderer exceptions, and subsequent recovery.

## Validation record

All pinned-container commands use `VITEST_MAX_WORKERS=2`. Targeted filters are
diagnostic runs only; the full test gate and Dockerfile have no exclusions.

| Run | Result |
| --- | --- |
| Original selected-profile test, alone | Pass, 3,153 ms |
| Original duplicate-Send test, alone | Pass, 2,891 ms |
| Original cross-device test, alone | Pass, 3,108 ms |
| Original three tests together | 3 passed |
| Original complete controller file | 90 passed |
| Original `npm run check` | 138 files / 1,718 tests passed; client typecheck and server/client builds passed; test duration 205.08 s |
| Fixed selected-profile test, alone | Pass, 2,827 ms |
| Fixed duplicate-Send test, alone | Pass, 2,561 ms |
| Fixed cross-device test, alone | Pass, 3,121 ms |
| Fixed three tests together | 3 passed (2,866 / 2,469 / 2,927 ms) |
| Fixed complete controller file | 91 passed; 113.32 s; reported cases passed in 2,737 / 2,439 / 2,820 ms |
| Fixed `npm run check` | 140 files / 1,732 tests passed; client typecheck and server/client builds passed; test duration 188.87 s |
| Unmodified upstream Dockerfile, native ARM64 | Complete image build passed; its gate passed 140 files / 1,732 tests in 191.71 s; client typecheck, server/client builds, SBOM generation and WASM checksum verification passed |

The separate local Node 26 development runs passed the
new publication tests and client typecheck; they are not the pinned runtime gate.

The actual Docker invocation used the standalone Buildx CLI because this host's
Docker CLI does not have its Buildx plugin installed:

```sh
/opt/homebrew/bin/docker-buildx build --builder colima \
  --platform linux/arm64 --build-arg BUILDPLATFORM=linux/arm64 \
  --progress=plain --load -t shelfsend:docker-gate-verification-20260914 .
```

The local verification-only image is `linux/arm64`, user `1000:1000`, digest
`sha256:a607595d9028feaede298b3dec956e4b4586b4ebeab60ec2616ab141f71cde7f`.
It was built from the final code/test working tree before committing; only this
validation record was completed afterward. Rebuild the pushed commit on RRserver
for release provenance rather than deploying this local verification tag.

The Docker gate's three reported cases passed in 3,060 / 3,116 / 3,169 ms.
Existing jsdom `scrollTo` notices and Vite's large-chunk warning remain non-fatal.

Local raw reports are retained in
`/tmp/shelfsend-gate-474f7f3.MrqdII/gate-verification-reports.tar.gz`, with
`final-docker-build.log` and `final-build-metadata.json` beside it.

Pending operator check, from the pushed fix checkout on native Linux amd64:

```sh
docker build --build-arg BUILDPLATFORM=linux/amd64 \
  --progress=plain -t shelfsend:verification .
```

## Omission and safety audit

- Selected-profile matching, managed-token rules, ambiguity thresholds and all
  current connection/epoch checks are unchanged.
- A successful duplicate-copy Send still verifies both copies and blocks resend.
- Failed B inventory cannot restore A's raw inventory or Send authority.
- No security hardening, schema migration (including v21), credential storage,
  EPUB processing, vendored WASM, dependency lock, test timeout, or Docker gate was
  removed or changed.
- No source EPUB metadata or device content was edited by this work.
- Deployment and native-amd64 validation remain separate operator steps. Do not
  close the RRserver-specific failures solely from these local ARM64 results.
