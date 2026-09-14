# Security maintenance and converter provenance

[Back to ShelfSend](../README.md)

This record preserves the security changes and historical validation performed
on 14 September 2026. It is not a current vulnerability scan or acceptance of
later commits. Validate each release with `npm ci`, `npm run check`, a fresh
image build and scan, and the [release checklist](../deploy/docker/RELEASE_CHECKLIST.md).

## Application hardening

The five confirmed findings from the September review were addressed:

| Finding | Implemented protection |
| --- | --- |
| Stalled HTTP responses retained capacity | Buffered delivery has idle and absolute deadlines through actual drain/close. Capacity remains reserved until the handler and response settle; expiry closes the owning socket. Large catalog routes reserve capacity before response hydration. |
| Duplicate-group derivation performed repeated scans | Indexed group identities replace quadratic scans while preserving duplicate semantics and stronger-evidence replacement. |
| Metadata lookup history amplified memory use | Schema 21 stores compact confidence facts, selects the newest ready entry in SQL, and reads candidate details in byte-bounded pages with revision guards. Imports resolve the exact reviewed entry. |
| EPUB metadata preparation delayed cancellation | Indexed series refinements and cooperative checkpoints make archive/XML/edit/rebuild work cancellable. Kindle preparation stays inside its existing deadline; Kobo retains its cancellation checks. |
| Credential-bearing SQLite files had overly broad permissions | Database and sidecars use `0600`; new data directories use `0700`. Canonical-path, symlink and non-blocking checks preserve unrelated files and reject unsafe sidecars. |

Regression coverage includes paused TCP readers, response expiry and capacity
recovery, large duplicate groups, bounded candidate hydration and pagination,
EPUB cancellation, and database/sidecar permissions. The existing source-size,
catalog, provider-review and device-safety boundaries remain in place.

The service has no built-in login. Keep it on a trusted LAN/VPN or behind an
appropriate access gateway. Profiles organize books; they do not restrict
access. Optional provider credentials and backups belong in private server
storage. See the [deployment guide](../deploy/docker/README.md).

## Dependency and image maintenance

The maintenance pinned the base to Node 24.21.0, applied signed Debian updates,
and removed npm, Corepack and Yarn from the runtime image. Build-stage npm and
the runtime Node/shell/archive recovery utilities remain available. Base index
and platform digests are recorded in [base-image.lock](../deploy/docker/base-image.lock).

In the recorded scan, the Debian PCRE2 update from `10.42-1` to
`10.42-1+deb12u1` removed six advisory matches; removing the old global npm tree
removed nine. The project npm audit reported no vulnerabilities at that time.
Cargo updates and converter rebuild evidence are retained below.

The historical Grype 0.118.0 scan still reported **212 runtime package/advisory
matches across 92 advisory IDs**, including Critical and High severities. Its
database classified 128 matches as `not-fixed` and 84 as `wont-fix`; no remaining
match had an available fixed package version in that database. These were
component matches, not demonstrated ShelfSend exploits. They were not suppressed
or treated as resolved. Rebuild with current signed package updates and rescan
the resulting image; a clean npm audit alone does not establish a clean image.

## Historical deployment validation

The maintenance image passed its complete Node 24.21.0 Linux ARM64 test/build
gate with two workers, unprivileged/read-only startup and readiness, masked
credential persistence, and `0600` SQLite/sidecar checks. Cold backup and restore
into a separate volume passed; SQLite integrity returned `ok` at schema 21,
and the restored image retained its test credential and served requests.

These results are historical evidence. No running household service or physical
reader was changed during that maintenance. Fresh integrated Kindle and Kobo
journeys, real household mounts, the trusted private HTTPS origin, and current
release/container validation remain separate [acceptance requirements](../deploy/docker/RELEASE_CHECKLIST.md).

## Converter rebuild

The following dated record retains the reproducible build commands, dependency
changes, artifact hashes, and test results. Full source and license material
remain in [third_party/boko](../third_party/boko); upstream revision and exact
downstream resource limits remain in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The two Cargo findings from the security review are fixed without changing
the browser converter's bytes, accepted resource limits, or conversion behavior.

### Dependency change

Only the two affected `rand` packages, their registry checksums, and their
referencing lockfile dependency entries changed:

| Path | Previous | Patched |
| --- | --- | --- |
| `phf_generator` build dependency | `rand 0.8.5` | `rand 0.8.6` |
| `proptest` development dependency | `rand 0.9.2` | `rand 0.9.3` |

These are the applicable patch versions for
[GHSA-cq8v-f236-94qc](https://github.com/advisories/GHSA-cq8v-f236-94qc).
The advisory requires a custom logger plus specific random-generator and
logging features; its presence in the original lockfile did not establish a
browser runtime exploit.

The updates were resolved by Cargo, not edited without registry verification:

```sh
cargo update -p rand@0.8.5 --precise 0.8.6
cargo update -p rand@0.9.2 --precise 0.9.3
```

### Reproducible browser build

Built in a disposable `rust:1.91.1-bookworm` Linux ARM64 container with:

- Rust 1.91.1 (`ed61e7d7e`, 2025-11-07).
- wasm-pack 0.13.1, obtained from its official versioned release.
- Cargo-locked wasm-bindgen 0.2.108.
- The existing downstream source and release profile, with no source changes.

```sh
wasm-pack build --target web --out-dir web/pkg --no-default-features --features wasm
```

The regenerated files matched the existing repository files exactly:

| File | SHA-256 |
| --- | --- |
| `client/vendor/boko/boko.js` | `738797303669e53c45c050537640d5535d8c54072b8770a78064e5b080c0d3cc` |
| `client/vendor/boko/boko_bg.wasm` | `5cc7e4fcd9116218ad7dcaae54e0dbfdead726069c4e6f40176e63a55605c338` |
| Updated `third_party/boko/Cargo.lock` | `3ac7bc1fdda2b9c879e0cf4b4bcbd70ab260c7783c29f21d21a2173028b3d86d` |

The generated artifact files required no change. The disposable compiler
container was removed after retaining the build evidence.

### Verification

Native tests used the repository's existing `tests/fixtures/epictetus.epub`
copied into the isolated source's expected `tests/fixtures/` directory. The
vendored source intentionally does not include that binary fixture; an initial
run without it had 13 missing-file failures, resolved by providing the fixture.

```sh
cargo test --locked --no-default-features --lib \
  --test epub3_nav_toc --test epub_href_decoding \
  --test font_deobfuscation --test normalized_export --test azw3_roundtrip
```

- Library tests: **679 passed**, zero failed.
- Focused integration tests: **22 passed**, zero failed.
- Existing browser tests covering actual WASM conversion and adversarial input
  remained green in the targeted application run.
- Grype's 2026-09-14 database reproduced **two** advisory matches in the original
  Cargo source and found **zero** in the patched source. Both scans used the same
  database and directory-scanning settings.

Automated results do not replace physical Kindle/Kobo or household deployment
acceptance. No device or live deployment was modified during this maintenance.
