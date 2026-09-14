# ShelfSend security hardening — 14 September 2026

This implements the five application findings in the [security review](security-review-2026-09-14.md) and the dependency updates available for the supported runtime. The no-login private LAN/VPN model, source immutability, supported book limits, provider review workflow, and device transfer safeguards are preserved.

## Finding-by-finding closure

| Finding | Implemented change | Regression evidence and user-visible compatibility |
| --- | --- | --- |
| SEC-01: stalled responses monopolize capacity | Buffered delivery has idle and absolute deadlines through actual drain/close, including static and cover bytes. Newer large catalog routes reserve capacity before hydrating responses. Ordinary requests retain capacity until both the handler and response settle. Expiry closes the owning socket even for responses queued behind SSE, so Node cannot retain their bodies after accounting is released. | Paused real TCP readers release capacity; homepage/catalog requests recover. Absolute/idle expiry, queued socketless responses, timer cleanup, and keep-alive restoration are tested. SSE keeps its separate long-lived lease. Existing file/catalog sizes and concurrency ceilings remain unchanged. Defaults: 30 seconds idle, ten minutes total; configurable up to one hour. |
| SEC-02: quadratic duplicate derivation | Indexed group identities retain the emitted issue and priority, replacing repeated scans of prior groups. | Existing duplicate semantics and stronger-evidence replacement remain intact. The review's 2,000-book /20,000-group stress case completed in approximately 144 ms, versus the original 24,185 ms. No smaller catalog ceiling or truncation was introduced. |
| SEC-03: candidate-history memory amplification | Schema v21 persists compact confidence facts and chooses the newest ready entry per book in SQL. Individual lookup jobs are read in byte-bounded pages with revision guards; imports fetch the exact selected entry. | Issue derivation hydrates zero candidate JSON bodies. Size-only SQLite reads precede candidate hydration; pages fit the existing response allowance. The browser automatically assembles every page, including create/control/run responses, and retries snapshot conflicts without replaying mutations. All retained jobs, books, candidates, and review/import choices remain available. |
| SEC-04: EPUB metadata blocks cancellation | Series refinements are indexed once. Archive/XML/edit/rebuild loops yield cooperatively and check cancellation. Kindle's existing five-minute deadline starts before source and cover reads; Kobo propagates its existing preparation checkpoint. A related nested encryption-declaration scan is also linear. | Linear operation counts, sparse series semantics, nested font-obfuscation declarations, actual mid-scan cancellation, stalled reads, and actual boko conversion are tested. Supported source/output sizes and metadata behavior remain unchanged. The converter WASM bytes are identical. |
| SEC-05: credential files readable by other accounts | Before SQLite opens, the main file and existing sidecars are secured to `0600`; new sidecars inherit that mode. New data directories are `0700`. Regular-file, symlink, and non-blocking checks avoid following sidecar links or waiting on FIFOs. | Tests cover new/legacy files, retained credentials, canonical database symlinks, unrelated-file preservation, FIFO rejection, and in-memory databases. Existing mount-directory permissions are not changed. Provider keys remain server-side and masked through Settings. |

## Dependency maintenance

- Pinned the official multi-architecture image for [Node 24.21.0](https://nodejs.org/en/blog/release/v24.21.0), which includes OpenSSL 3.5.8. Both AMD64 and ARM64 manifest digests are recorded in `deploy/docker/base-image.lock`.
- Runtime builds apply signed Debian package updates. `libpcre2-8-0` is upgraded from `10.42-1` to `10.42-1+deb12u1`, addressing all six PCRE2 matches in the review. See [Debian's package tracker](https://security-tracker.debian.org/tracker/source-package/pcre2).
- Removed npm, Corepack, and Yarn from the final runtime. Build-stage npm and the runtime's Node/shell/archive recovery utilities remain available. The nine advisory matches from the old global npm tree disappear.
- Patched Cargo `rand` to `0.8.6` and `0.9.3`. A pinned toolchain rebuild produced byte-for-byte identical JavaScript/WASM. **679 Rust library tests and 22 integration tests passed**. [Detailed build evidence](security-hardening-2026-09-14-boko.md).
- The project npm advisory scan reports **zero** vulnerabilities. Cargo scanning changed from **two** matches to **zero**.

### Remaining upstream advisories

Using the same Grype 0.118.0 database as the original review, the patched runtime has **212 package/advisory matches across 92 advisory IDs**, down from **227 matches across 107 IDs**. No remaining match has an available fixed package version in that scanner database: 128 matches are classified `not-fixed` and 84 `wont-fix`. The remaining severities include Critical and High; they have not been suppressed or represented as resolved. These are component matches, not demonstrated ShelfSend exploits.

The completed application image reproduced the same remaining match set. A [machine-readable inventory](security-hardening-2026-09-14-dependencies.json) records every resolved and remaining runtime match. The remaining packages include Debian libc, Perl, system utilities, archive tools, and support libraries. Their advisory details remain in the [original inventory](security-review-2026-09-14-dependencies.md), excluding the fifteen resolved runtime matches described above. Changing to a different base distribution or removing recovery utilities would require a separate compatibility assessment; this change preserves the documented backup/restore workflow. Future rebuilds must refresh signed package updates and rescan the resulting image; a clean npm audit alone is insufficient.

## Validation record

- Final Docker `npm run check`: **138 test files /1,718 tests passed**, with client/server TypeScript checks and the production Vite build passing. The complete test run took 209.49 seconds under Node 24.21.0 on native Linux ARM64 with two workers.
- All six HTTP delivery regressions, including real pipelined SSE and paused TCP readers, are included in that complete passing gate.
- The unprivileged, read-only runtime with no external network passed startup/readiness, homepage/catalog, masked provider credential persistence, and `0600` database/WAL/SHM checks. npm/Corepack are absent, and recovery utilities remain available.
- The documented cold-backup and non-overwriting restore scripts passed using disposable data volumes. SQLite integrity verification returned `ok` with schema v21. The final image then started from the restored database, retained the test credential, served readiness/homepage successfully, and maintained private database/sidecar modes. The disposable volumes and backup files were removed afterward.
- Cargo rebuild/native test and dependency scanner evidence is linked above. The final application image rescan confirms the same 212 remaining component matches /92 advisories, with no available fixed versions reported. No tests were skipped or their deadlines loosened.
- SHA-256 comparison confirmed that all 19 checked security implementation, dependency, converter, and new regression-test files in the validated image match the workspace. Unrelated concurrent device/UI edits were preserved.

The first overlapping host/Docker gate was stopped after resource contention caused timing failures. A subsequent host run also encountered Kindle-progress UI assertions being updated by concurrent workspace work. Validation retains all tests and their original deadlines; test parallelism is bounded to two workers for the final host and Docker gates. This changes build/test resource usage only.

## Compatibility verification before publication to main

A fresh fetch confirmed remote `main` at `5f005efb3f697622447eefe9c37f2ff13cacc311` (measured Kindle indexing progress). The security changes were still uncommitted and absent from that branch. Static review found no compatibility conflicts with the newer device-wide inventory or header-progress behavior; their implementation and handoff notes remain intact.

The combined working tree then passed `VITEST_MAX_WORKERS=2 npm run check` on Node 26.4.0: **138 test files /1,718 tests passed**, followed by both TypeScript checks and the production build. The test run took 172.06 seconds. No implementation changes were needed for compatibility. The existing GPL license is also recorded in the package manifests for the image's SBOM metadata.

## Deployment and acceptance scope

The additive schema v21 migration preserves metadata history, including compact-fact backfill for existing entries. As with existing schema upgrades, rollback to an older application uses its matching cold backup rather than reopening the upgraded database with old code.

The validated local image is `kindle-bridge:security-hardening-20260914`, ID `sha256:5181847fe64e13b6671dcb21546b8c9d12c2acaf8cfc510ada209ea63edee863`. Its deployment has not been performed. No running household service, host-mounted book, physical Kindle, or Kobo was changed. Physical-device and real household HTTPS/mount acceptance remain separate from automated validation.
