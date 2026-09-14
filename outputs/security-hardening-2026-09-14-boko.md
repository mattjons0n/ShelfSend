# boko security maintenance evidence — 2026-09-14

The two Cargo findings from the security review are fixed without changing
the browser converter's bytes, accepted resource limits, or conversion behavior.

## Dependency change

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

## Reproducible browser build

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

## Verification

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
