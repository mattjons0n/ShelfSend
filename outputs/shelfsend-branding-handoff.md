# ShelfSend branding handoff

> **Scope:** This implementation record predates Kobo support. Shared library features now serve the selected e-reader; protocol details, action labels, and device evidence here retain their original Kindle scope. See the current [device guide](../docs/devices.md).

## Scope completed

- ShelfSend name in the corner wordmark, browser title, onboarding, Settings/help/recovery text, user-facing match/update messages, and current README/handoff documentation.
- Local books-and-send-arrow brand mark, matching SVG browser icon, and “Browser to reader” corner subtitle. The original README used “From your browser to your e-reader”; the current README describes both supported reader integrations.
- The original branding change retained Kindle action labels. Current shared connection wording uses **Connect eReader**; reader-specific Send and Kindle-only removal/update labels remain explicit.
- Existing package name, repository URL, website address, Docker image/service/volume names, environment variables, browser keys, device locks, recovery journals, managed identities, and Kindle cache filenames retained. No data migration or external repository/domain rename.
- The original branding change included no feature work or transfer policy changes. Later documentation edits use ShelfSend branding and distinguish shared features from device-specific behavior.

## Validation

- Both dedicated branding/compatibility tests pass after correcting their browser-environment setup and Node file-URL handling.
- Production type checks and server/client build passed.
- Chrome visual check of the built app verified the ShelfSend corner name/mark/subtitle and browser title against the isolated test catalog.
- One final `npm run check` ran with `VITEST_MAX_WORKERS=1`: 961 passed, 5 failed across 97 files / 966 tests. It had loaded the earlier branding fixtures before their fixes (two failures); the other three failures were existing five-second timeouts in two controller tests and the provider/pasted-image test. The corrected branding file passed 2/2, the controller cases passed 2/2 (70 skipped), and the pasted-image case passed 1/1 (9 skipped). No timeout or performance threshold was loosened and the complete suite was not repeated. This is not a claim of a clean full-suite or Docker run.

## Deployment

Push the branding commit to the existing GitHub main. Bob/server operator still owns the Docker build gate and RRserver promotion. This change does not itself rename or redeploy the running container, repository, or public address.
