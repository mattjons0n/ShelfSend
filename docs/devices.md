# E-reader support and workflows

[Back to ShelfSend](../README.md)

ShelfSend sends books from your browser to the e-reader connected to that computer. The shared library, profiles, shelves, series discovery, metadata editor, and Send-later queue work alongside separate reader integrations. Your Docker server indexes and serves books; it never operates a device.

## Choose your reader

Use desktop Chrome or Edge on a trusted HTTPS origin, or localhost. Plug the reader into your browsing computer with a data-capable USB cable, then choose **Connect eReader**. Connect one reader at a time.

| Capability | Kindle | Kobo |
| --- | --- | --- |
| Connection | Browser WebUSB chooser and MTP session | Browser folder picker for the mounted USB drive |
| Source formats for sending | DRM-free EPUB; supported uncompressed/PalmDOC AZW3 | DRM-free EPUB |
| Browser preparation | EPUB-to-AZW3 conversion and PDOC preparation | Prepared EPUB with any reviewed metadata/cover overlays |
| Single and batch Send | Available | Available |
| Send-later queue | Revalidated against the connected reader before sending | Revalidated against the connected reader before sending |
| Confirmed device presence | Strong current managed-copy or supported metadata evidence | Verified current ShelfSend-managed copy only; other files may remain possible matches |
| Update an existing copy | Guarded upload-first update for one exact stale managed EPUB presentation | Unavailable |
| Remove an existing copy | Explicitly confirmed, freshly revalidated exact matches | Unavailable |
| Reading information | Bounded recorded sidecar activity; automatic percentage and Read/Unread detection remain disabled | Reading-state synchronization unavailable |
| Finish a transfer | Allow device indexing and check the transferred title | Safely eject through the OS, unplug, then allow device import |

DRM-protected books are unsupported. Source downloads are bounded to 200 MiB. AZW3 HUFF/CDIC compression and embedding edited AZW3 metadata/covers are unsupported. Kobo does not currently receive KEPUB or AZW3 conversions.

## Shared workflow

1. Select the library/profile you want to use.
2. Connect your e-reader and complete its permission prompt.
3. Wait for the reader-specific checks and library comparison.
4. Send eligible books individually, as a list selection, or from **Send later**.
5. Follow per-book progress and verification. Resolve any interrupted-transfer recovery message before sending again.

The selected reader determines formats, matching, and available actions. A saved queue, a previous connection, or a possible match cannot authorize a new transfer or deletion on its own. Source files stay immutable; edits and conversion apply only to derived copies.

## Kindle connection and recovery

Choose **Connect eReader → Kindle**. On a clean connection, the browser runs an exact-byte write/read/delete self-test, reads the live MTP inventory, and compares it with the selected library. Pending cleanup permits read-only recovery inventory first; acknowledgement must be followed by a fresh self-test, inventory, and reconciliation before Send resumes.

Kindle-specific behavior includes PDOC preparation for embedded cover display, exact-handle removal/update, and bounded device-resident metadata caching. Prepared sideloads appear under **Documents**. See the [technical guide](technical-guide.md#kindle-workflow) for the detailed rules.

## Kobo connection and recovery

Choose **Connect** on the reader's screen so the USB drive mounts on your computer. In ShelfSend, choose **Connect eReader → Kobo**, select the main drive containing `.kobo`, and allow read/write folder access.

ShelfSend writes prepared EPUBs into its own folder. It does not overwrite existing books, alter `.kobo`, or edit the reader's database. Its recovery flow identifies exact interrupted files for inspection; do not delete unrelated files. Existing-copy removal and update controls are unavailable.

After verification, eject the drive through your operating system and unplug it so the reader can import the books. ShelfSend's **Disconnect** button is not an OS eject. See the [Kobo implementation record](../outputs/kobo-build-plan.md) for limits and recovery details.

## Library ownership and device presence

**View series** compares Hardcover's series roster with all indexed books in the selected library. **In your library**, **Missing**, and **Possible match** describe library ownership. They do not establish that a book is on the connected e-reader, authorize deletion, or download a missing volume.

Device presence comes from the current reader integration. Keep uncertain matches visible and verify the selected reader before acting.

## Physical evidence

The original Kindle transfer engine was physically tested on USB IDs `0x1949 / 0x9981`, including conversion, transfer, opening, chapter navigation, and cover display. Fresh acceptance of the expanded integrated workflow remains separate.

Kobo's browser transfer implementation has automated and rendered-UI evidence. Physical transfer/import/opening/cover/navigation/cancellation/recovery acceptance remains pending. Neither a successful byte check nor an automated test establishes on-device reading behavior.

Each supported reader must be accepted at the intended private HTTPS origin and with the real household library mounts. Historical reports name the device actually tested; their findings do not establish compatibility for another model or integration.
