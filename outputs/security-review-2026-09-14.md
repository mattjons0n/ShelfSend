# ShelfSend security review — 14 September 2026

This review found **five confirmed code-level security defects: four Medium and one Low**, plus known vulnerable packages in the pinned Docker base image. Severity reflects the intended private LAN/VPN deployment. The intentional absence of login and the use of profiles as organizational views are not findings.

The review covered the current working tree. No application code, dependencies, configuration, mounted books, or device contents were changed. Existing changes to `package.json` and `package-lock.json` were preserved. The report and dependency inventory are the review deliverables.

## Findings

### SEC-01 — Medium: two stalled downloads can block the application indefinitely

**Code:** [server/http-server.ts:2342](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/http-server.ts:2342>), [asset responses:2450](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/http-server.ts:2450>), [server timeouts:261](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/http-server.ts:261>).

The server permits two simultaneous buffered responses. Each slot remains reserved until its response emits `finish` or `close`. There is no deadline for an active buffered response to finish sending. The wait timeout applies only to subsequent requests waiting for a slot; the HTTP request/header timeouts govern incoming requests and do not close these stalled response bodies. Cover-read deadlines are also cleared after `response.end(data)` rather than after the response drains.

**Trigger and impact:** a client that can reach the service requests two sufficiently large assets and stops reading while leaving both sockets open. The actual shipped 2.4 MiB boko WASM file was sufficient. Both slots remain occupied, making the homepage and catalog endpoints unavailable to other users. The health endpoint can still report healthy. This needs no profile/book identifier or large request flood. An upstream proxy with an effective response-write deadline can limit the impact; the application itself does not enforce one.

**Evidence:** an isolated server using the actual WASM file retained both slots after two paused downloads. `/` and `/api/profiles` returned `503 buffered_response_busy`; `/api/healthz` returned `200`. Closing the two sockets restored `/api/profiles` to `200`. The probe shortened only the queued wait timeout to 250 ms; the active-slot policy remained unchanged. The underlying Node response socket timeout was `0`.

**Hardening:** enforce an absolute lifetime and appropriate write-idle timeout for every active buffered response. Destroy stalled responses and release their leases on expiry. Retain the existing concurrency limit and test with paused real TCP readers.

### SEC-02 — Medium: duplicate detection has quadratic CPU cost on the server

**Code:** [shared/catalog-issues.ts:269](</Users/mattias/Documents/ChatGPT/Kindle Web Library/shared/catalog-issues.ts:269>), [server/catalog-database.ts:3429](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/catalog-database.ts:3429>).

For every duplicate bucket, the algorithm copies and searches all previously emitted groups. An upgrade to a stronger explanation also searches the accumulated issue list. This makes certain valid metadata arrangements require quadratic work. Issue derivation runs synchronously in the HTTP server before pagination and filtering.

**Trigger and impact:** attacker-influenced ebooks or metadata overlays contain identifiers shared between many distinct pairs of books. Once that metadata is in the catalog, a single request for the issues page, even with `limit=1`, computes all groups and blocks every client on the server event loop. HTTP deadlines and health requests cannot run during the synchronous computation.

**Evidence:** the actual derivation function, with 20 allowed identifiers per book and no unrelated missing-metadata issues, produced these results:

| Books | Duplicate groups | Measured synchronous time |
| ---: | ---: | ---: |
| 250 | 2,500 | 261 ms |
| 500 | 5,000 | 916 ms |
| 1,000 | 10,000 | 3,401 ms |
| 2,000 | 20,000 | 24,185 ms |

The inputs stayed within the book, identifier, and issue-count limits. These are bounded local function measurements; the code establishes that the same computation is on the HTTP request path.

**Hardening:** use a map keyed by the exact group identity, retaining its priority and issue reference, instead of scanning previous groups. Add an aggregate work budget and keep expensive derivation off the HTTP event loop.

### SEC-03 — Medium: retained metadata lookup results can exhaust server memory

**Code:** [server/catalog-database.ts:3638](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/catalog-database.ts:3638>), [candidate storage limit:4083](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/catalog-database.ts:4083>), [individual job hydration:3909](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/catalog-database.ts:3909>).

Issue derivation selects complete `candidates_json` bodies for every retained ready lookup entry and materializes them with SQLite `.all()`. Only afterward does it discard older entries for books already seen. Retention allows 100 jobs × 100 books, with up to 2 MiB of candidate data per entry. The HTTP response-size limit is applied after these allocations and does not protect this operation. Individual job reads also materialize all candidate bodies before response-size validation.

**Trigger and impact:** sufficiently large retained provider results, including attacker-influenced provider metadata, accumulate through otherwise valid lookup jobs. An ordinary issues request can then allocate hundreds of megabytes or more, potentially terminating a memory-constrained server. The prerequisite is retained provider data; an arbitrary small request against an empty catalog does not produce this amplification.

**Evidence:** the real Google Books normalizer and public database lifecycle methods stored 100 completed jobs for just one book. Each normalized result was 678,173 bytes, below the 2 MiB limit. `listCatalogIssues(profile, {limit: 1})` returned 847 bytes but increased JavaScript heap usage by 68,694,776 bytes and RSS by 68,501,504 bytes. The permitted maximum entry count could load approximately 6.8 GB at this observed payload size; the absolute configured allowance approaches 20 GiB of candidate JSON. Those maximum sizes were calculated, not allocated during testing.

**Hardening:** select only the newest relevant entry per book in SQL. Store/query compact confidence facts for issue derivation instead of full provider responses. Enforce aggregate retained/read byte budgets and paginate candidate hydration before allocating or parsing variable-size collections.

### SEC-04 — Medium: crafted EPUB series metadata can monopolize the browser main thread

**Code:** [client/src/api/epub-overrides.ts:438](</Users/mattias/Documents/ChatGPT/Kindle Web Library/client/src/api/epub-overrides.ts:438>), [Kindle preparation:convert.ts:83](</Users/mattias/Documents/ChatGPT/Kindle Web Library/client/src/api/convert.ts:83>), [Kobo preparation:prepare.ts:97](</Users/mattias/Documents/ChatGPT/Kindle Web Library/client/src/kobo/prepare.ts:97>).

When only a series number is overridden, the EPUB transformer checks every collection element and rescans every metadata child for a matching collection-type refinement. This is quadratic within the accepted XML byte and element limits.

**Trigger and impact:** the user edits only the series number of an attacker-supplied EPUB containing many collection declarations and then sends it. The transformation executes on the browser main thread. For Kindle it happens before the conversion worker and its five-minute timeout are created. Kobo's timeout/checkpoints cannot interrupt the synchronous inner loop. Large accepted inputs can make the application unresponsive and prevent cancellation until the loop finishes or the tab is terminated.

**Evidence:** actual EPUB derivative code accepted sources that also passed the server metadata parser. At 100, 200, and 400 collection elements, the instrumented DOM recorded 10,302, 40,602, and 161,202 attribute reads. The EPUBs were only 6,465, 12,165, and 23,565 bytes. Local jsdom times were 57 ms, 360 ms, and 2,299 ms. **These are jsdom timings, not Chrome/Edge benchmarks**; the quadratic operation count and main-thread execution are established directly.

**Hardening:** index collection-type references once, then resolve collections by map lookup. Cover the entire preparation pipeline with an interruptible execution boundary and cancellation, including work performed before WASM conversion starts.

### SEC-05 — Low: provider credentials inherit overly broad database permissions

**Code:** [server/catalog-database.ts:743](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/catalog-database.ts:743>), [Dockerfile:76](</Users/mattias/Documents/ChatGPT/Kindle Web Library/Dockerfile:76>), [server/catalog-service.ts:127](</Users/mattias/Documents/ChatGPT/Kindle Web Library/server/catalog-service.ts:127>).

SQLite is opened without enforcing private file permissions. With the conventional `0022` umask, the database, WAL, and shared-memory files are created as `0644`. The Docker image creates `/data` with default directory permissions; later `mkdir` calls do not tighten an already-existing directory. Provider API keys are stored in the database and can appear in the WAL.

**Trigger and impact:** another local account can traverse a shared or insufficiently restricted data bind mount/directory. It can read provider credentials despite those credentials being masked by the HTTP API. This is conditional local disclosure, not a remote API key leak. Host-level restrictions on Docker's volume storage can already prevent access, and the documented private-volume requirement reduces exposure.

**Evidence:** a disposable `0755` data directory, umask `0022`, and the actual credential initialization path produced `0644` database/WAL/SHM files. A fake test credential was present in the WAL. No real credentials were inspected.

**Hardening:** default to a service-private data directory and `0600` database/WAL files, using a restrictive service umask and safe existing-file handling. Preserve an intentional shared-group setup only through explicit configuration. Plaintext server-side credential storage itself is not the finding.

## Dependency findings

The current project lockfile's npm advisory scan returned **zero reported vulnerabilities**. That does not cover the Docker base image's operating-system packages or its globally installed npm dependencies.

Grype 0.118.0, with a vulnerability database built on 14 September 2026, found **227 package/advisory matches covering 107 distinct advisory IDs** in the exact pinned Node base image. The locally built ShelfSend image had the identical match set. Upstream severities include Critical and High, but these are **component matches, not 107 demonstrated ShelfSend exploits**. Some relate to absent use cases, privileged tools, or architecture-specific behavior.

Specific actionable installed-package findings include:

- `libpcre2-8-0` 10.42-1: six advisories; Debian's patched package is 10.42-1+deb12u1. Two are rated High, including [CVE-2026-86145](https://security-tracker.debian.org/tracker/CVE-2026-86145) and [CVE-2026-89161](https://security-tracker.debian.org/tracker/CVE-2026-89161). No ShelfSend HTTP-to-PCRE2 exploit path was established.
- The image's global npm tree contains `brace-expansion` 5.0.7, `tar` 7.5.19, `ip-address` 10.2.0, and `undici` 6.27.0 with published advisories. Relevant patched floors include [brace-expansion 5.0.9](https://github.com/advisories/GHSA-rgw5-rvv9-x895), [tar 7.5.21](https://github.com/advisories/GHSA-r292-9mhp-454m), and [ip-address 10.3.1](https://github.com/advisories/GHSA-mwp4-54f8-5fhr); the scanner reports undici 6.28.0. These copies belong to npm tooling, not the application's imports or Node's built-in fetch implementation.
- The vendored Cargo lockfile has two Low matches for [the rand custom-logger advisory](https://github.com/advisories/GHSA-cq8v-f236-94qc): rand 0.8.5 via `phf_generator` and rand 0.9.2 via development dependency `proptest`. Build/test dependency paths and the custom-logger prerequisite do not establish a browser WASM vulnerability.

Refresh and rescan the pinned base image, address fixable OS packages, and remove unnecessary package-manager tooling from the final runtime image where practical. Track deferred advisories by actual applicability. Do not interpret the clean project npm audit as a clean container bill of health.

**Every scanner match is enumerated in the [dependency inventory](</Users/mattias/Documents/ChatGPT/Kindle Web Library/outputs/security-review-2026-09-14-dependencies.md>).** It groups duplicate binary-package matches under their advisory IDs, retains upstream severities and fix states, and distinguishes them from the five reproduced code defects.

## Validation and coverage

- `npm run check` passed on Node v26.4.0: **131 test files, 1,589 tests**, client typecheck, server build, and production client build. An initial sandbox run could not bind local HTTP sockets; the complete rerun with the needed local permissions passed.
- Review and targeted probes covered HTTP host/origin/CORS controls, request/body/response limits, source containment and snapshots, metadata parsing and worker boundaries, provider URL/redirect handling, credential persistence, SQL construction, durable lookup/queue/shelf/annotation state, browser rendering and URL handling, EPUB preparation, device matching/mutation safeguards, and Docker/backup configuration.
- The checked-in boko JavaScript and WASM SHA-256 hashes match the repository's documented values.
- A targeted scan of current tracked files found no matches for common private-key headers or AWS, Google, GitHub, and OpenAI key formats. This is not an exhaustive secret-history or entropy scan.
- No concrete SQL injection, stored XSS, provider SSRF, arbitrary source-file download, or broad device-deletion bypass was confirmed in the reviewed paths.
- Reproductions used disposable local servers, synthetic metadata, temporary databases, and fake credentials. No attacks were run against the user's running library, live provider accounts, mounted originals, Kindle, or Kobo.

This is a source/configuration review with automated dependency scans and bounded reproductions, not proof that every possible vulnerability is absent. The private HTTPS/LAN/VPN deployment, host permissions, and expanded physical device flows still require their own acceptance checks. The image scan covered the locally available arm64 image and pinned base; amd64-specific applicability was not tested. The app image was built on 4 September; its matching base package set was independently verified against the base pinned by the current Dockerfile.

## Suggested hardening order

1. Close the buffered-response lifetime gap (SEC-01).
2. Remove quadratic issue derivation and bound retained-data hydration (SEC-02/03).
3. Fix EPUB preparation complexity and cancellation coverage (SEC-04).
4. Enforce private credential file permissions (SEC-05).
5. Refresh/minimize the container base and triage the enumerated dependency advisories.

This order preserves the intentional no-login private-network design and browser-local conversion/device architecture.
