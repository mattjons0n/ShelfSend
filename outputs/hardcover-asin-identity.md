# Exact ASIN identification for Hardcover

## Outcome

Use a local book's Amazon ASIN to look up its matching Hardcover edition and book directly. A matching edition may provide an ISBN; an ISBN is not required to identify the Hardcover work or its series. Never assign a sibling paperback's ISBN to an EPUB just to make matching succeed.

## Implementation

- Recognize typed ASIN identifiers and bare Amazon B-prefixed ebook ASINs; ignore UUIDs as provider identifiers.
- Query Hardcover editions by exact ASIN before text search. When an ISBN is also supplied, check both. Different book identities or conflicting authors remain review choices.
- Carry both identifiers through book discovery, individual metadata lookup and bulk lookup. Preserve original identifiers when an edited presentation omits them; explicit edits to search terms do not retain a hidden, stale ASIN.
- Use ASIN identity in series ownership for the selected library. Resolve matching editions beyond the roster's first 20 editions in one additional bounded request, scoped to the displayed Hardcover work IDs and the selected library's ASINs.
- Cache provider identity results for five minutes with credential and identifier-set keys; recompute local ownership against the current catalog. Preserve provider pacing, cancellation, response limits and errors. No per-book network loop.
- Keep ISBN/title fallback for books whose ASIN is absent from Hardcover. An exact ASIN success does not need a title match or title cleanup.
- Existing review/apply controls remain in charge of metadata overlays. No EPUB writes, new credentials, migrations or Kindle transfer/deletion matching changes.

## Bounds and safety

Exact discovery uses at most one ASIN request and one ISBN request before the existing bounded fallback. Series edition resolution permits up to 20,000 unique local ASINs and 50 displayed work IDs, with a 2,000-row response ceiling and an extra truncation sentinel. Overflow is an error, not a misleading partial ownership result. Provider and local response byte limits remain in effect.

## Validation

Regression tests were added before implementation for exact lookup, same-edition ISBNs, missing ISBNs, UUID exclusion, identifier/author conflicts, duplicate records, cancellation, provider errors, metadata workflows and the series HTTP API. The HTTP regression uses unrelated local titles to prove that ASIN ownership does not depend on title cleanup. Additional tests cover profile scoping, source/edited identifiers and cache invalidation.

Final validation on 2026-09-11:

- `npm run check`: 1,229 tests passed; one existing 10,000-book performance test exceeded its 45-second ingest limit (45.96 seconds). All ASIN regressions passed. The failed test prevented this command from reaching its build phase.
- That performance test passed when run alone (34.52 seconds for the test, 34.89 seconds overall). No performance thresholds or implementation were changed.
- `npm run build`: passed client/server type checks and production build after correcting a readonly-array type in a new test fixture. The existing large-bundle warning remains.
- The affected client ASIN workflow suite was rerun after the fixture correction and passed.
- `git diff --check`: clean. Independent review found no remaining must-fix issues.

Requirement audit: exact ASIN lookup, same-edition ISBN retrieval, ISBN-free work/series identity, individual/bulk lookup, series ownership, source/edited identifiers, profile isolation, ambiguity/error safeguards and bounded cached requests are covered. No source-file or Kindle matching changes; no additional credential setup. Validated on `codex/user-experience-polish`. Publishing the branch does not deploy the running server.

Fixture-backed tests do not establish whether Hardcover currently contains a particular user's ASIN. No live-account or physical Kindle validation is claimed.

## Usage

With the existing Hardcover token configured in Settings, use the normal Hardcover book/series actions or choose Hardcover in metadata lookup. There is no additional setup. Review a suggested ISBN before applying it to the catalog.

## References

- [Hardcover's official schema](https://github.com/hardcoverapp/hardcover-docs/blob/main/schema.graphql): edition `asin`, `isbn_10`, `isbn_13` and book relationships.
- [Amazon KDP ISBN guidance](https://kdp.amazon.com/en_US/help/topic/G201834170): ebooks do not require an ISBN.
