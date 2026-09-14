# Kindle experimental gates and retained findings

These notes preserve the device findings and acceptance requirements needed to maintain ShelfSend without local development journals. They apply to the Kindle integration, particularly the physically tested USB pairing `0x1949 / 0x9981`. The [device guide](devices.md) covers supported workflows; the [release checklist](../deploy/docker/RELEASE_CHECKLIST.md) covers acceptance of a complete release.

Automated fixtures verify software bounds, operation ordering, and rejection of unsafe evidence. They cannot establish physical device behavior. The original single-book Kindle transfer succeeded, but expanded queue, matching, update, removal, cache, and reconnect acceptance remains pending.

## Current defaults

| Capability | Current behavior | Remaining gate |
| --- | --- | --- |
| Exact-byte self-test | Runs on every clean connection before normal inventory and write readiness; policy remains `always` | Expanded physical connection, transfer, recovery, and reconnect acceptance |
| Managed EPUB update | Available only for one freshly revalidated stale ShelfSend-managed presentation; upload, verify, and durably record before exact old-copy deletion | Physical success and interruption matrix |
| `GetPartialObject` (`0x101b`) | Development diagnostic only; production metadata uses bounded full-object reads | Advertised support, correct bounded responses, transport faults, and measured benefit |
| KFX/AZW8 metadata sidecar | `kfxSidecarMetadata: false`; ordinary inventory retains conservative incomplete metadata | Exact physical layout, parser fields, and reconciliation |
| Semantic reading status | `readingSidecars: false` and independent browser presentation gate disabled | Trustworthy percentage semantics and an independently proven explicit Read/Unread field |
| Recorded reading data | Separate read-only `recordedReadingData: true` observations shown for a confirmed copy in book details | Integrated physical drawer/deployment acceptance; observations never establish completion |

Internal experimental gates are not ordinary Settings or container configuration options. A cache, probe result, or reading observation never grants device mutation authority.

## Managed replacement acceptance

An eligible edited EPUB must be re-fetched, source/presentation-bound, prepared, converted, and verified before device mutation. The transaction requires a current connection self-test, complete inventory, exact old-object revalidation, coexistence capacity, collision-resistant upload, new-object verification, durable delivery recording, a second old-object revalidation, exact-handle deletion, absence verification, and reconciliation. Insufficient temporary capacity must never trigger delete-first replacement.

Physical acceptance must cover an edited EPUB and cover, readable replacement with correct cover/navigation, exact old-copy absence, reconnect, and unchanged source bytes. Exercise insufficient space and interruption before upload, after upload, before deletion, during deletion/absence verification, and before final reconciliation. At each boundary a known readable old or verified new copy must remain. Ambiguous, possible/manual-only, stale, protected, or edited-AZW3 targets must never authorize deletion.

Failure to durably record the verified upload keeps both copies. Failure during exact old-copy cleanup keeps the verified replacement and requires intervention. Recovery records remain bounded explanatory evidence; they do not authorize later deletion without new live checks. If acceptance fails, hide Update and keep its intervention records inert.

## Partial-object metadata reads

The development probe requires a user-armed next clean connection, the ordinary self-test and complete inventory, then explicit selection and confirmation of one unprotected readable book directly inside Documents. The device must advertise `0x101b`. The probe exposes byte-free counts, response codes, timings, and equality results; it does not export sampled book bytes.

The protocol has unsigned range/overflow checks and a 4 MiB per-request allocation ceiling. Probe samples are capped at 64 KiB. A whole-object comparison reference is limited to 256 KiB by default and 1 MiB maximum.

Before integrating partial reads into production, capture physical advertised operations; test prefix, overlap, middle, tail, repeat, exact EOF and beyond-EOF behavior; compare a small object against bounded `GetObject`; repeat after reconnect; and measure bytes/time for small and large supported books. Exercise abort, deadlines, cable loss, invalid ranges/handles, short or excess data, and response-count mismatches. Fatal transport or protocol desynchronization retires the connection and must not fall back to another read on that session. Keep production partial reads disabled unless correctness and a useful benefit are proven.

**`GetObjectPropList` (`0x9805`) remains prohibited on `0x1949 / 0x9981`.** The exact device is covered by Calibre/libmtp's broken-operation flags, as documented with pinned source links in the [backlog](../BACKLOG.md#probe-partial-object-metadata-reads-on-the-physical-kindle). A successful partial-read probe does not change that prohibition.

## KFX/AZW8 metadata sidecars

Normal hierarchy traversal prunes `.sdr` descendants. The default-off reader permits only the exact unique sibling `<book stem>.sdr/assets/metadata.kfx`, with fresh live parent checks. Defaults bound inspection to 2,000 books, 32 direct children per folder, 4 MiB per sidecar, and 128 MiB total. Its CONT/ENTY/PackedIon parser keeps only bounded title, author, identifier, and language fields. It never downloads the main KFX/AZW8 book as a fallback.

Acceptance needs a real unmanaged KFX/AZW8 sample, verified live layout/container versions, a legally usable sanitized fixture, independently confirmed parsed fields, unchanged sidecar bytes, and diagnostics proving that only the expected sidecar was read. Repeat reconciliation after reconnect. Missing, ambiguous, conflicting, malformed, or unsupported-version evidence must remain unknown. Accept each physical format subset separately; otherwise retain `kfxSidecarMetadata: false`.

## Reading data and semantic status

Physical reading-sidecar capture established LONG container version 1, timer structure version 0, and BYTE last-position version 2. The corrected parser decoded all 32 captured AZW3 reading files. Physical comparison also showed that timer activity fractions can disagree with the Kindle's displayed percentage and completed status. No explicit Read/Unread field has been established, and an `EndActions` record did not consistently identify completed books.

These are retained format findings, not a current release test result. Personal titles, exact reading history, raw reports, and local paths are intentionally excluded from this document.

The available book-details section reports recorded time, counted words, saved positions/timestamps, and bounded technical fields. It labels timer fractions as recorded activity, not completion. Observations stay in the browser session, are associated with one confirmed copy, and become labelled last-seen data after disconnection. They never feed semantic status filters, automatic Read-books membership, or device mutation authority.

The separately gated semantic reader allowlists direct `.sdr` children for AZW3 `.azw3f`/`.azw3r`, KFX/AZW8 `.yjf`/`.yjr`, and legacy `.mbs`/`.mbp1`. Defaults bound it to 2,000 books, 4,000 candidate sidecars, 32 direct children, depth one, 2 MiB per object, and 64 MiB total. Sidecars are never written, renamed, or deleted.

Before enabling semantic status for any format:

1. Compare managed PDOC AZW3 at not-started, mid-book, and completed states, after book close, reconnect, and device reboot. Establish exact paths, versions, refresh timing, percentage/timestamp meaning, and agreement between paired files.
2. Independently prove an explicit Read/Unread field. Never infer Unread from 0%, Read from 100%, or completion from a timer fraction. A validated position denominator and separate completion evidence are required.
3. Verify unchanged sidecar bytes and that missing, malformed, duplicate, conflicting, stale, unsupported, unenumerated, possible-match, and ambiguous evidence remains Unknown and cannot attach to another catalog book.
4. Confirm disconnect, BFCache, and long-hidden lifecycle retirement, accessible grid/list presentation, and pagination/profile-scoped filtering. Test real KFX and legacy formats separately before enabling those format gates.

Only opaque per-profile/book completion membership may persist in server annotations after a valid explicit Read observation. Raw sidecars, positions, percentages, device identity, timestamps, and reading history remain browser-local. Automatic population remains disabled until the physical semantic gate passes.

### Local diagnostic workflow

For deliberate format research, run the development client and open `http://127.0.0.1:5173/reading-diagnostic.html` on the USB-connected computer. This separate development-only entry is excluded from the production build. Its chooser is user initiated and the collector is read only; it releases the session after completion, cancellation, or failure.

The downloaded report includes full Documents paths/ObjectInfo, notes, raw Base64 sidecar bytes, hashes, parser results, and omissions. It can contain personal reading information: keep it local and sanitize any fixture before committing or sharing. Nothing is automatically uploaded. Bounds are 10,000 visited objects, depth 32, 8 MiB per file, 64 MiB attempted reads, and five minutes total. Fatal transport failure or cancellation stops collection.

Inspect an explicitly supplied report offline with `node scripts/inspect-reading-report.mjs <report.json>`; add `--structure` for bounded decoded fields. The script uses the application parser and does not upload or modify the report.

## Self-test cadence decision

Four recorded physical connections measured roughly 0–1 second for the exact-byte self-test and 20–21 seconds for inventory. Those observations justify keeping policy `always`; they do not establish performance for other devices or later software. Adaptive attestation helpers remain inert and cannot authorize mutations.

Reconsider only with fresh separate self-test/inventory timings and a physical matrix covering first use, storage or policy change, expiry, reboot, USB/MTP faults, interrupted writes, lifecycle changes, pending recovery, cleanup failure, explicit diagnostics, and concurrent mutations. Any future deferred test must run exactly once in the current session before the first Send, Remove, Update, or cache write. Prior-session evidence must never be labelled current-session proof.
