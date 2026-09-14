# Kobo transfer guide

[Back to ShelfSend](../README.md) · [Device comparison](devices.md)

ShelfSend sends DRM-free EPUBs to a Kobo drive mounted on the computer running your browser. The browser prepares and verifies each copy; the Docker server does not need USB access, a Kobo account, or additional device settings.

## Connect and send

1. Open ShelfSend in desktop Chrome or Edge over trusted HTTPS, or localhost. The browser must support folder access and allow storage for interrupted-transfer recovery.
2. Connect Kobo to that computer with a data-capable USB cable and choose **Connect** on the reader. Disconnect any active reader session in ShelfSend first.
3. Choose **Connect eReader → Kobo**, select the main Kobo drive containing `.kobo`, and grant read/write folder access. Select the drive itself, not a book subfolder.
4. Wait for the library comparison. Use **Send to Kobo** for an eligible EPUB, a list selection, or your **Send later** queue.
5. Wait for **Sent to Kobo**, safely eject the drive through your operating system, then unplug and allow Kobo to import its books. ShelfSend's **Disconnect** button does not eject the drive.

ShelfSend validates the current source and applies reviewed metadata or cover edits to a derived EPUB. It writes a new file in the drive's `ShelfSend` folder, then checks the copied size and SHA-256 before reporting success. Mounted library originals, existing device books, `.kobo`, and Kobo's internal database remain unchanged.

## Presence and duplicate checks

Only a verified current ShelfSend-managed copy receives a confirmed Kobo badge. ShelfSend rechecks existing managed copies before reporting a retry as already present. A matching filename alone is insufficient: other books may appear as **Possible match**, and incomplete scans or ambiguous copies remain uncertain. Inspect possible matches on your computer and refresh the reader comparison before sending again.

These results apply to the selected library and its current book versions. Hardcover series ownership does not establish Kobo presence. An edited book does not authorize replacing its older copy; existing-book update and removal are unavailable in Kobo mode.

## Cancellation and recovery

Use the active transfer's progress control to cancel. Cancellation waits for any operating-system write, close, or abort to finish. ShelfSend then removes only the exact new file created by that transfer and verifies its absence.

If unplugging, permission loss, or a browser interruption prevents verified cleanup, further sends are blocked and a recovery message identifies the file to inspect:

1. Reconnect the Kobo and grant folder access again if requested.
2. Inspect the exact file named in the recovery message under `ShelfSend`. Remove only that file if it is incomplete. Do not clear the folder or delete unrelated books.
3. Acknowledge the inspection in ShelfSend and wait for the refreshed library comparison before resuming.

If the saved filename is unavailable, the recovery message asks you to inspect the `ShelfSend` folder. Acknowledgement records your inspection; it does not automatically remove old files. Keep browser storage available so recovery records can survive a reload.

## Limits and acceptance status

- Plain DRM-free EPUB is supported. Source and prepared files are limited to 200 MiB, with additional archive and processing bounds. Malformed, oversized, changed, or unsupported sources are rejected.
- KEPUB conversion, AZW3-to-EPUB conversion, reading-state synchronization, device-side shelf/database editing, and existing-book update/removal are unavailable.
- Only one ShelfSend tab can hold the Kobo connection at a time. Resolve denied or revoked folder permission before retrying.
- A successful byte check establishes the transferred file's contents. It does not establish that Kobo imported, displayed, or opened the book.

**Physical Kobo acceptance remains pending.** Automated transfer and interface checks use fixtures. Real-device acceptance must cover unedited and edited EPUBs, single and batch transfers, duplicate prevention, cancellation, unplugging/permission loss, reconnect and recovery, then opening, covers, and navigation after safe eject/import. Test with the intended private HTTPS origin and real household mounts, and confirm originals and Kobo system/database files remain unchanged.
