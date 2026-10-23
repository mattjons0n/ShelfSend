# E-reader support and workflows

[Back to ShelfSend](../README.md)

ShelfSend sends books from your browser to the e-reader connected to that computer. The shared library, profiles, shelves, series discovery, metadata editor, and Send-later queue work alongside separate reader integrations. Your Docker server indexes and serves books; it never operates a device.

## Choose your reader

Use desktop Chrome or Edge on a trusted HTTPS origin, or localhost. Plug the reader into your browsing computer with a data-capable USB cable, then choose **Connect eReader**. Connect one reader at a time.

| Capability | Kindle (MTP) | Kindle USB drive | Kobo |
| --- | --- | --- | --- |
| Connection | Browser WebUSB chooser and MTP session | Browser folder picker for mounted Kindles, including Oasis | Browser folder picker for the mounted USB drive |
| Source formats for sending | DRM-free EPUB; supported uncompressed/PalmDOC AZW3 | Same as Kindle MTP | DRM-free EPUB |
| Browser preparation | EPUB-to-AZW3 conversion and PDOC preparation | Same as Kindle MTP | Prepared EPUB with reviewed metadata/cover overlays |
| Single and batch Send | Available | Available | Available |
| Send-later queue | Revalidated before sending | Revalidated before sending | Revalidated before sending |
| Confirmed device presence | Strong current managed-copy or supported metadata evidence | Exact byte-verified current ShelfSend-managed copy only | Exact byte-verified current ShelfSend-managed copy only |
| Update an existing copy | Guarded upload-first update for one exact stale managed EPUB presentation | Unavailable | Unavailable |
| Remove an existing copy | Explicitly confirmed, freshly revalidated exact matches | Unavailable | Unavailable |
| Reading information | Bounded recorded sidecar activity; automatic percentage and Read/Unread detection remain disabled | Unavailable | Unavailable |
| Finish a transfer | Allow device indexing and check the transferred title | Safely eject through the OS, then unplug | Safely eject through the OS, then unplug |

DRM-protected books are unsupported. Source downloads are bounded to 200 MiB. AZW3 HUFF/CDIC compression and embedding edited AZW3 metadata/covers are unsupported. Kobo does not currently receive KEPUB or AZW3 conversions.

## Shared workflow

1. Select the library/profile you want to use.
2. Connect your e-reader and complete its permission prompt.
3. Wait for the reader-specific checks and library comparison.
4. Send eligible books individually, as a list selection, or from **Send later**.
5. Follow per-book progress and verification. Resolve any interrupted-transfer recovery message before sending again.

The selected reader determines formats, matching, and available actions. A saved queue, a previous connection, or a possible match cannot authorize a new transfer or deletion on its own. Source files stay immutable; edits and conversion apply only to derived copies.

## Kindle connection and recovery

Choose **Connect eReader → Kindle (MTP)**. On a clean connection, the browser runs an exact-byte write/read/delete self-test, reads the live MTP inventory, and compares it with the selected library. Pending cleanup permits read-only recovery inventory first; acknowledgement must be followed by a fresh self-test, inventory, and reconciliation before Send resumes.

Kindle-specific behavior includes PDOC preparation for embedded cover display, exact-handle removal/update, and bounded device-resident metadata caching. Prepared sideloads appear under **Documents**. See the [technical guide](technical-guide.md#kindle-workflow) for the detailed rules.

## Kindle USB-drive connection

Choose **Connect eReader > Kindle USB drive** for an Oasis or another Kindle that mounts as a disk. Select the main volume containing `documents` and `system/version.txt`, not the `documents` subfolder. Desktop Chrome or Edge supports this on trusted HTTPS or localhost. Brave may require enabling **File System Access API** at `brave://flags/#file-system-access-api` and relaunching; localhost does not require a certificate.

**On Device** shows all supported files found under `documents`, including books outside the server catalog. The scan includes MOBI, AZW, AZW3, PRC, KFX, AZW8, PDF, and TXT, while skipping hidden files and `.sdr` folders. The scan is bounded to 10,000 entries and eight folder levels.

Embedded PalmDB/MOBI titles and authors are displayed and searchable. Metadata reads use only the header and record-zero prefix: at most 1 MiB per prefix, 32 MiB total, and 2,000 candidates per scan. Missing, malformed, unsupported, or over-budget metadata falls back to the filename. Embedded covers load lazily for supported unencrypted MOBI/AZW/AZW3/PRC files, with 32 MiB per-file and 256 MiB per-connection read limits, plus the existing bounded thumbnail cache. Files and images stay in the browser; neither is uploaded to the catalog server. Cover or metadata availability does not establish a catalog match.

Sending accepts EPUB and supported AZW3 sources, not arbitrary MOBI/AZW files. EPUB conversion and reviewed edits use the existing browser-local Kindle preparation. New AZW3 copies receive collision-resistant names under `documents/ShelfSend`, with SHA-256 read-back verification and separate interrupted-transfer recovery records. Existing device books, Calibre files, and system folders are never overwritten or broadly deleted. Exact failed-upload cleanup applies only to the newly created file; uncertain cleanup requires manual inspection.

The folder connection does not use MTP self-tests, device-resident metadata cache slots, or MTP update/removal authority. Existing-copy update/removal and reading-state synchronization are unavailable. Safely eject through your operating system after sending; **Disconnect** is not an OS eject.

## Kobo connection and recovery

Choose **Connect** on the reader's screen so the USB drive mounts on your computer. In ShelfSend, choose **Connect eReader → Kobo**, select the main drive containing `.kobo`, and allow read/write folder access.

ShelfSend writes prepared EPUBs into its own folder. It does not overwrite existing books, alter `.kobo`, or edit the reader's database. Its recovery flow identifies exact interrupted files for inspection; do not delete unrelated files. Existing-copy removal and update controls are unavailable.

After verification, eject the drive through your operating system and unplug it so the reader can import the books. ShelfSend's **Disconnect** button is not an OS eject. See the [Kobo transfer guide](kobo.md) for limits and recovery details.

## Library ownership and device presence

**View series** compares Hardcover's series roster with all indexed books in the selected library. **In your library**, **Missing**, and **Possible match** describe library ownership. They do not establish that a book is on the connected e-reader, authorize deletion, or download a missing volume.

Device presence comes from the current reader integration. Keep uncertain matches visible and verify the selected reader before acting.

## Physical evidence

The original Kindle transfer engine was physically tested on USB IDs `0x1949 / 0x9981`, including conversion, transfer, opening, chapter navigation, and cover display. Fresh acceptance of the expanded integrated workflow remains separate.

The 2019 Oasis (`0x1949 / 0x0004`) has been connected through the USB-drive path, with 92 scanned files and real embedded covers visible in the browser. Physical acceptance of the new metadata display, sending, Kindle import/opening, and interrupted-transfer recovery is still pending. Browser-side cover display does not establish Kindle-side transfer success.

Kobo's browser transfer implementation has automated and rendered-UI evidence. Physical transfer/import/opening/cover/navigation/cancellation/recovery acceptance remains pending. Neither a successful byte check nor an automated test establishes on-device reading behavior.

Each supported reader must be accepted at the intended private HTTPS origin and with the real household library mounts. Historical reports name the device actually tested; their findings do not establish compatibility for another model or integration.
