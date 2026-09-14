# Device-file cover previews — 2026-09-14

## Scope and implementation

The standalone **On Kindle** view uses only art embedded in the exact device file. It never substitutes indexed library covers, edited catalog artwork, provider images, or title/author matches. Library views retain their existing matching and covers.

1. A read-only PalmDB/MOBI parser resolves the EXTH cover record, falling back to the embedded thumbnail. It accepts bounded JPEG, PNG, GIF and WebP images, returns only owned image bytes, and leaves the source unchanged. Missing, encrypted, malformed and unsupported files return no cover.
2. Visible rows request one optional read at a time after a complete device scan. Fresh exact object and ancestor facts are checked before and after reads. Foreground operations take priority; an in-flight MTP response drains before another operation starts. No partial-object capability or device thumbnail-directory probing is enabled.
3. Extracted art is cached only in the browser. Cross-session reuse requires pseudonymous device/storage identity and exact unadjusted path, format, size and modification timestamp. Missing timestamps disable persistent reuse. Cached raster content and MIME are revalidated. Cache entries never become matching or removal authority.
4. The UI decodes/downscales art into small thumbnails and updates only the cover slot. Device changes, stale results, changed file facts and URL cleanup are handled independently of the catalog. Missing covers retain the book icon.

## Resource limits

- Whole-device-file reads: 32 MiB per file, 256 MiB per connection.
- Embedded raster: 12 MiB; maximum 8192 pixels per dimension and 40 million pixels.
- Browser device-cover cache: 256 entries / 32 MiB; maximum 4 MiB per persisted image.
- Display thumbnails: at most 240 pixels on the longest side; 120 URLs / 8 MiB retained.
- No device writes, backend uploads, provider calls, schema changes or source-file edits.

## Requirement audit

| Requirement | Coverage |
| --- | --- |
| Device view shows file-derived art only | Dedicated extractor/reader/presenter; no catalog cover fallback |
| Library matching stays in library views | Existing matching paths unchanged; preview controller does not require a match index |
| Connecting stays independent of previews | Lazy visible-row work starts after the connection scan |
| No unsafe USB concurrency | Foreground-priority runtime lane and exact revalidation |
| No stale cross-device covers | Runtime/device evidence, session reset and late-result guards |
| Missing/unsupported art remains usable | Placeholder without disrupting inventory or transfer readiness |
| Bounded browser resources and cleanup | Read/cache/decode limits and object-URL revocation |

## Validation

- Extractor: 11 passing tests, including real bundled boko conversion of `epictetus.epub` and byte-immutability checks.
- Runtime/cache plus existing runtime regressions: 4 files / 47 tests passed.
- UI/presenter plus existing view/publication regressions: 4 files / 65 tests passed, including cleanup-pending guards and a regression proving that repeated off-page refreshes do no cover-related DOM work.
- Controller: 5 new device-cover tests passed, including missing catalog matches, incomplete/absent/disconnected inventory, late results and fatal transport errors.
- Isolated real Chromium: converted the fixture EPUB into a 514,859-byte AZW3, extracted its 315,448-byte JPEG and displayed a 160×240 `blob:` thumbnail. Missing art retained its icon even with a catalog association. Details, focus, scroll and search survived. Reset revoked all image URLs. Real IndexedDB reuse succeeded across cache instances; changed device/timestamp evidence missed. No catalog or external requests were made. [Browser evidence](/tmp/kindle-covers-smoke.eC8cMk/report.json), [screenshot](/tmp/kindle-covers-smoke.eC8cMk/on-kindle-covers.png).
- Final `VITEST_MAX_WORKERS=2 npm run check` passed on macOS ARM64 / Node 26.4.0: **144 test files / 1,784 tests**, test duration **168.91 seconds**, followed by successful client typechecking, server compilation and production client build. Vite reported its large-chunk advisory. [Full check log](/tmp/shelfsend-device-covers-check-verified.log).
- Compatibility review against main's Kobo icon commit `d14fd0e1afe75b415639435e0a33ad779737f7d7` found no conflicts. The Kobo asset and renderer remain unchanged; the four additional shared-stylesheet rules target Kindle inventory cover slots only. A fresh combined Kobo/view/cover regression run passed **9 files / 228 tests**, followed by another successful production build.
- An initial sandboxed full run was stopped after server tests hit localhost `listen EPERM`. The next permission-enabled full run had three existing controller-test timeouts; those tests passed together both on the feature checkout and an unchanged HEAD archive. Off-page preview overhead was subsequently removed, and the final full gate above passed. The precise cause of the earlier timeouts was not established. No exclusions, assertions, or test timeouts were weakened. [Earlier full run](/tmp/shelfsend-device-covers-check-final.log), [baseline targeted results](/private/tmp/kindle-covers-baseline.n2sqvX/targeted-results.json).

No physical Kindle acceptance, Docker verification or deployment is claimed for this change. To try it locally, reload ShelfSend, reconnect the Kindle, wait for indexing and open **On Kindle**; covers should appear as their rows come into view.
