# Hardcover decorated-title lookup

## Build plan

1. Reproduce the reported E-Day / Dark Moon miss through both public provider methods in regression tests before editing production code.
2. Generate at most three distinct text queries: original title, a recognized series/volume suffix removed, then a corroborated series/volume prefix removed. Preserve the author in every fallback; do not strip arbitrary subtitles or number-bearing titles.
3. Share the bounded lookup loop between metadata and book discovery. Keep ISBN-first queries, deduplicate provider identities and detail fetches, and stop once credible evidence is found.
4. Represent exact ISBN, original-title/author, and cleaned-title/author/series/volume evidence separately. Only a unique strong match may be auto-selected; truncated or ambiguous results remain choices. Rank suggestions without rewriting their titles or changing source metadata.
5. Run the focused regression suite, then one final `npm run check`. Preserve provider errors, cooldown, cancellation, response limits, and current caching boundaries.

## Scope

This affects Hardcover lookup only. No EPUB/source metadata changes, Kindle matching or mutation changes, new providers, or deployment are included. The original query and successful ISBN/exact-title paths stay first; no book or author is hard-coded.

## Implemented behavior

`hardcover-search.ts` owns the query variants and typed match evidence. A suffix such as `(E-Day Trilogy Book 3)` provides a series/position hint; `E-Day III:` can be removed only when that hint agrees. Without a suffix, only a named series followed by an explicit Book/Volume prefix is eligible. Plain subtitles, arbitrary parentheses, standalone numbers, and bare Roman-numeral titles are not stripped. Missing authors disable cleaned queries.

Both lookup paths share one search loop. Original queries and ISBN success remain first. At most three search/detail pairs (plus optional ISBN lookup) reuse the existing request lane, timeout, abort signal and cooldown. Repeated IDs reuse their fetched details. Evidence ranks ISBN first, exact original title/author next, then cleaned title/author corroborated by the candidate's series and volume. All equally strong book identities remain choices; any truncated discovery search disables automatic selection. Metadata confidence is checked for each series suggestion, not inferred from a different membership.

## Validation

- Tests were written before production changes. Red baseline: 18 failed, 20 passed, reproducing the reported behavior through discovery and metadata APIs.
- Initial targeted check after the fix: 81 tests passed across the new fallback file and both existing Hardcover provider files.
- An additional regression covers a successful cleaner query after a truncated irrelevant search: rank the correct book first, but keep automatic selection disabled.
- Final `npm run check` passed: 1,158 tests in 109 files, client/server TypeScript validation, and production build. The existing bundle-size advisory remains. The exact reported ID, title, author and series are a mocked regression fixture from the supplied live investigation, not a fresh live-account verification.

All requested cases are covered: original and ISBN-first success, empty or irrelevant nonempty results, conservative variants, author/series/volume conflicts, ambiguity, deduplicated/bounded requests, and provider failures/cancellation. No Kindle matching files or metadata-write paths were changed.
