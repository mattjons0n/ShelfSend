# Dashboard display controls and main promotion

## Build plan

1. Add a small-to-large card slider beside the grid/list controls. Bound grid minimum widths to 180–280 px in 20 px steps; keep text readable and let responsive columns wrap. Preserve list density separately.
2. Add a Books per page selector at the bottom right, on the same row as Show more on desktop. Offer 12, 24, 48, 96 and 200 books; retain the existing response-size safety fallback and ordinary page navigation.
3. Remember choices per library in the existing bounded browser context and URL. Changing page size resets to the first page and clears hidden selection, while keeping search and filters. Cancel obsolete page requests.
4. Verify rendering, live controls, focus, persistence and request bounds; run the full tests and production build. Push the scoped change to `codex/kobo-support`, then fast-forward `main` in a clean checkout after validating that exact tree.

## Implementation and requirement audit

- Card slider: implemented with live CSS preview while dragging and persistence on release, without replacing the input during each preview. Focus survives catalog updates; committed values do not override restored routes.
- Readability: fixed text sizes, wrapping titles/authors, intact format/size labels and a responsive minimum-width grid. Shrinking the grid changes columns rather than scaling text.
- Page selector: implemented for grid and list, including short/empty results. The right-aligned selector and Show more share a footer; small screens wrap the count above the controls. Show more opens the next page, not an unbounded growing list.
- State: profile-scoped, bounded and backward-compatible. Existing ISBN/Hardcover matching, immutable source files and both reader transport/cleanup paths are unchanged.
- Automated coverage: new state/context/route, rendered markup and actual AppView interaction regressions. Includes late request cancellation, effective reduced limits, disabled transfer controls and keyboard focus.
- Browser checks: real app renderer and all production styles, using sample books. Both slider extremes retain title/author/format/size with no detected horizontal overflow; desktop footer controls align and light-mode narrow footer remains readable.
- Publication scope: only this change is included. Existing unrelated README/package licensing edits and untracked documentation remain untouched. The previous Kobo-only publication restriction is superseded by the user's explicit request to promote Kobo support to main.

## Release boundary

A successful test/build and main push make this code available for deployment; they do not deploy a server or prove hardware compatibility. Physical Kobo import/open/cancel/recovery acceptance, fresh integrated Kindle acceptance and intended private-HTTPS/mount validation remain required as documented in [the Kobo plan](kobo-build-plan.md).
