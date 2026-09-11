# Kobo browser-transfer build plan

Branch: `codex/kobo-support`, created from `codex/user-experience-polish` at `3b8806361271e1ddf025cff052b6ff60114ca8d0`.

## Goal

Let a user connect a Kobo mounted on their computer, send DRM-free EPUBs from the existing catalog, see verified Kobo presence and progress, and cancel safely. Keep the standard Docker service and existing Kindle workflow intact. No converter service, Calibre, cloud storage, Kobo account credentials or host-specific package.

## Milestones

### 1. Browser-local Kobo connection

- Add an explicit Connect Kobo action using the browser's read/write directory picker.
- Require a supported secure browser context and a user-selected Kobo root, identified by its `.kobo` directory.
- Never edit Kobo's internal database or system folders. Scope writes to ShelfSend's own book folder.
- Hold an exclusive browser-operation lock, surface denied/revoked permission clearly, and allow disconnect without pretending the browser has ejected the drive.

### 2. EPUB preparation

- Re-fetch the selected profile's current book and source; verify size, SHA-256, presentation version and EPUB structure.
- Apply reviewed metadata/cover overlays to a derived EPUB using the existing bounded rewriter.
- Transfer EPUB directly: do not convert to AZW3 or add Kindle PDOC metadata.
- Reject DRM, malformed/oversized archives, source changes and AZW3-only books before device writes.

### 3. Verified transfer and recovery

- Generate collision-resistant managed filenames, never overwrite an existing book, and stream bounded chunks.
- Close the writer and verify the resulting file's size and SHA-256 before reporting success.
- Revalidate existing managed copies before treating a retry as already present.
- Cancel cooperatively, abort the writer, remove only the exact file created by that operation, and verify absence.
- Persist a bounded interrupted-operation journal before creation. If unplugging, permission loss or a crash prevents proof of cleanup, explain which exact file needs inspection; never claim cancellation removed it or delete stale filenames automatically.

### 4. Catalog and interface

- Keep Kobo statuses separate from Kindle matching/deletion authority and scoped to the selected library.
- Reconcile a bounded inventory with current catalog versions. A filename alone is not proof of a valid transferred book; verify managed file contents before showing a confirmed badge.
- Reuse inline single-book Send/progress/cancel and the compact list-mode batch progress dialog.
- Label actions and filters for Kobo while connected; keep Kindle removal/update controls unavailable in Kobo mode.
- Preserve libraries, metadata editing, Hardcover discovery and existing Kindle behavior.
- Handle catalog/profile changes without overlapping device operations or falsely marking incomplete scans as absent.

### 5. Verification and publication

- Add transport, EPUB preparation, controller/service and UI regressions, including success, duplicate retry, cancellation, permission loss, wrong folder, source/profile races and hash mismatch.
- Run focused tests during development, then the full `npm run check` and production build. Record actual results and any failures.
- Inspect the real rendered Kobo controls in a browser without pretending a mocked filesystem is a physical Kobo.
- Complete the requirement audit, commit only this feature's files, and push `codex/kobo-support`. Do not push to main or the user-experience branch.

## First-version boundaries

- Plain DRM-free EPUB only. KEPUB conversion, AZW3-to-EPUB conversion, reading-state synchronization, device-side shelf/database editing, and existing-book removal/update are not part of this first Kobo implementation.
- Existing unmanaged books may remain uncertain. No fuzzy/Hardcover association becomes device deletion authority.
- File System Access depends on browser/OS support and explicit permission. The Docker server never accesses the reader attached to the user's computer.
- Browser verification confirms file bytes, not that Kobo has imported, indexed or opened the book. Safely eject using the operating system, unplug, and allow Kobo to import it.
- Native filesystem writes cannot be forcibly canceled by JavaScript. Cancellation waits for any in-flight write/close/abort to settle, then verifies cleanup. If removal cannot be proven, the recovery record remains and further sends are blocked.

## Using this version

1. Open ShelfSend in desktop Chrome or Edge over trusted HTTPS (or localhost).
2. Plug Kobo into the same computer and choose **Connect** on the reader. Disconnect an active Kindle session first.
3. Click **Connect Kobo**, select the main Kobo drive (containing `.kobo`), and grant folder access. No new Docker setting or server-side USB access is needed.
4. Wait for the library comparison, then click **Send to Kobo** on an EPUB. List selection and Send later use the connected reader too. Click an active card's progress button to cancel.
5. Wait for **Sent to Kobo**, safely eject the drive through the operating system, then unplug and allow Kobo to import its books. ShelfSend's Disconnect button is not an OS eject action.

Only a verified current ShelfSend-managed copy earns a confirmed Kobo badge. Other filenames can be possible matches; AZW3-only books cannot be sent. Existing books are not overwritten or removed.

## Physical acceptance — required before claiming Kobo compatibility

On a real Kobo and the intended private HTTPS origin: connect; accept folder permission; transfer an unedited and an edited EPUB; test single/batch progress, duplicate prevention, cancel during writing, unplug/permission loss, reconnect and recovery; verify books, covers and navigation after safe eject/import. Confirm source files and Kobo system/database files remain unchanged. Retest the existing Kindle connection/transfer flow.

## Evidence

- Implemented the five milestones on the new branch; source branch and main were not changed.
- `npm run check`: **1,318 tests passed across 118 files**; client typecheck, server compilation and production client build passed. The existing non-failing bundle-size advisory and jsdom `scrollTo` notices remain.
- Focused coverage includes 22 transport, 36 catalog-session, 13 EPUB-preparation and 13 Kobo UI tests, plus four added controller-routing cases. The complete controller file passed 84 tests separately.
- Browser accessibility inspection verified the real renderer's Kobo navigation, connection panel, inline Send, confirmed status and disabled AZW3 action using simulated device data. An isolated headless Chrome screenshot then checked the desktop layout and caught a light-colored wrapper and low-contrast subtitle; both were corrected. The final production build was repeated after this CSS-only correction.
- No real Kobo files, USB transfers, device database, import process or original library files were used in these checks. **Physical Kobo acceptance is pending.**
- [Desktop render checked with simulated device data](kobo-desktop-check.png).

## Requirement-by-requirement audit

- New branch based on the user-experience branch: done; `codex/kobo-support` starts at the exact base revision above.
- Browser-local Kobo connection and direct EPUB transfer: implemented; initial folder permission remains user initiated.
- Metadata and cover edits: applied only to a hash-checked derivative; mounted originals remain unchanged.
- Progress, batches, cancellation, duplicate prevention and recovery: implemented and covered by automated tests; physical acceptance remains explicit.
- Kindle behavior and mutation authority: separate state and transport paths; no Kobo matches can authorize Kindle removal or replacement. Existing automated Kindle coverage passed.
- Platform-agnostic Docker, private deployment, no Calibre/cloud/new credentials: preserved; no backend/device plumbing or packaging added.
- Git publication: publish only the new Kobo branch. Existing unrelated README/package licensing edits and the untracked documentation directory are excluded from this feature commit.

## References

- [Kobo: copy EPUBs to the mounted reader and safely eject](https://help.kobo.com/hc/en-us/articles/360024775093-Add-non-protected-PDF-and-ePub-files-to-your-Kobo-eReader-using-your-computer)
- [Chrome: user-granted file and directory access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
