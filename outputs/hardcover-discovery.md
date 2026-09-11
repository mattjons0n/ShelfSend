# Hardcover book and series discovery

Implemented on 2026-09-11 for the `codex/user-experience-polish` development branch. Server deployment is separate.

## How to use

1. Save a Hardcover token with catalog and search access in Settings, if one is not already configured.
2. Click a book's cover or title. **Explore on Hardcover** looks up that book by ISBN, then title and author when needed.
3. Use **View on Hardcover** to open its external book page, or **View series** for the series popup. Choose a book or series when there is more than one candidate.
4. The popup shows covers where available, titles, authors, volume positions (including 0 and 1.5), and **In your library**, **Missing**, or **Possible match**. Local matches can be opened directly. Longer series have **Load more books**.

These are selected-library statuses, not Kindle statuses. Offline source folders do not erase ownership. Looking at a series never applies metadata suggestions, downloads books, or changes mounted originals.

## Completed implementation units

- Provider discovery: separate ISBN/title lookup and ordered, paged series queries; use Hardcover-provided slugs or its documented book-ID redirect, without guessing titles into URLs. Reuses existing server-only credentials and paced request lane.
- Selected-library presence: bounded read-only database iteration over source and effective metadata across every catalog page; valid ISBN equivalence or title/author evidence, with ambiguous matches distinguished. Explicit errors instead of false missing labels if catalog limits are exceeded.
- API integration: profile-scoped GET routes for book lookup and series pages; five-minute bounded provider cache tied to credential revision, with fresh library matching on every request. Stale source/presentation responses are rejected.
- Interface: actions in the existing details drawer and one centered responsive popup; loading, setup, no-result, no-series, error/retry, pagination, keyboard and close/profile cancellation behavior. No stacked active dialogs or new download actions.

## Verification

- Provider discovery: 23 focused tests passed.
- Read-only library matching: 18 focused tests passed.
- HTTP integration: 4 focused tests passed.
- Client: 8 new focused regressions passed; existing surrounding client tests also passed during targeted validation.
- Rendered UI checked in a desktop browser in dark and light modes and at a 390-pixel narrow viewport, using sample data with the real renderer and styles.
- `npm run check` was run once: 1,117 tests passed and the existing catalog-scale test exceeded its 45-second ingest budget by 0.8 seconds (107 passing files, one failing file). That test passed on its single isolated rerun (35 seconds total). The full run is not claimed as green; its early exit required a separate production build.
- `npm run build` passed: client typecheck, server compilation, and production client bundle. Vite retains its existing large-bundle advisory.
- A live Hardcover account/token lookup has not been exercised here; mocked provider tests and a rendered fixture do not establish live account acceptance.

## Requirement check

Both requested actions are present. The popup uses Hardcover's roster, including unowned books, shows each reported position without rounding, and scopes library membership to the active profile. Existing metadata review, original source files, converter, and Kindle transfer/deletion behavior are unchanged.
