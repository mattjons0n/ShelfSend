# On Device gallery and list — 2026-09-14

## Implemented

- Renamed the device navigation and page headings to **On Device**, preserving existing `on-kindle` routes and bookmarks. In-library Kindle/Kobo filters remain reader-specific comparisons.
- The standalone Kindle inventory supports a cover gallery and a row list. Shared library controls retain layout, bounded card size (180–280 px), and list density through the existing browsing preferences. Grid remains the default when no saved list preference exists.
- Titles, authors, format, size, and expandable file details come from device inventory. Independent search, 100-file pages, stale/incomplete warnings and membership outside catalog libraries remain intact.
- Cover slots use only the existing device-file reader/browser cache. Layout changes reuse loaded artwork; missing art stays a placeholder. Gallery thumbnails are capped at 480 px on the longest side; the 120-URL / 8 MiB retained-image limit and USB read limits are unchanged.
- Partial updates preserve search selection, slider focus/uncommitted previews, open file details, and scroll position. Device cards have no catalog selection, transfer, removal, or match-review actions.
- Kobo connector photos and existing Kobo comparison behavior remain unchanged.

## Validation

- Renderer, interaction, presenter and Kobo regression checks pass. New coverage exercises both layouts, unchanged device membership, search, card sizing, slider focus, cached-cover reuse and reader-specific library filters.
- Real isolated Chromium checks found and fixed a compact-density CSS specificity conflict. Desktop, 390 px and 320 px layouts then had no horizontal overflow, including long titles/authors/paths; controls and missing-art placeholders behaved correctly, with no catalog or remote image requests.
- Final `VITEST_MAX_WORKERS=2 npm run check` passed on macOS ARM64 / Node 26.4.0: **144 files / 1,793 tests**, test duration **174.05 seconds**, followed by successful client typechecking, server compilation and production client build. Vite retained its large-chunk advisory. [Full log](/tmp/shelfsend-device-gallery-check-final.log).
- The final higher-resolution Chromium recheck passed all eight desktop/mobile scenarios with real **320×480** thumbnails, no horizontal overflow and no catalog/external requests. [Browser report](/tmp/kindle-covers-smoke.eC8cMk/gallery-480-report.json), [desktop gallery](/tmp/kindle-covers-smoke.eC8cMk/desktop-gallery-large-480.png), [mobile gallery](/tmp/kindle-covers-smoke.eC8cMk/mobile-gallery-large-480.png).

This is browser presentation work: no source edits, device writes, matching-policy changes, physical-device acceptance, Docker deployment, commit or push is implied by these checks.
