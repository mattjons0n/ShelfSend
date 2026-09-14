/** Real renderer fixtures for browser-computed theme/contrast regression checks.
 * No device, provider, network, or durable catalog actions are performed. */
import type { CatalogBrowserSnapshot, CatalogMetadataEditorState } from "../../client/src/catalog-browser";
import type { CatalogBook, CatalogBookMetadataState, CatalogHealthIssue, CatalogProfile, CatalogRoot, MetadataLookupJob } from "../../client/src/catalog-client";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { renderKindleDeviceContents, renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { settingsDraftFromProfile } from "../../client/src/library-settings-prototype";
import { initialAppState, type AppState } from "../../client/src/state";
import { BUILT_IN_SHELF_IDS } from "../../shared/shelf-order";
import type { HardcoverBook, HardcoverLibrarySeriesPage } from "../../shared/hardcover-contracts";

export interface ThemeContrastFixture { readonly name: string; readonly html: string }

const profile: CatalogProfile = { id: "prf_theme", name: "Home", description: "Our collection", initial: "H", sourceLabel: "Fiction", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 3 };
const root: CatalogRoot = { id: "root_theme", profileId: profile.id, label: "Fiction", path: "/libraries/fiction", recursive: true, watch: true, enabled: true, status: "watching", lastScanAt: "2026-09-14T09:00:00Z" };
const books: CatalogBook[] = ["The First Journey", "Beyond the Horizon", "A New Beginning"].map((title, index) => ({
  id: `book_theme_${index}`, profileId: profile.id, rootId: root.id, sourceFilename: `${title}.epub`, title,
  authors: ["Alex Author"], authorSort: "Author, Alex", language: "en", publisher: "Example Press", publishedAt: "2024",
  series: "The Journey", seriesIndex: index + 1, description: "A story about a journey into the unknown.", subjects: ["Fiction"], identifiers: [],
  format: "epub", size: 1024 * (index + 1), contentHash: String(index).repeat(64), addedAt: "2026-09-14T08:00:00Z", updatedAt: "2026-09-14T08:00:00Z", metadataComplete: true, available: index !== 2,
}));

const metadata: CatalogBookMetadataState = {
  book: { ...books[0], metadataEdited: true },
  sourceMetadata: { title: books[0].title, authors: [...books[0].authors], authorSort: books[0].authorSort!, language: "en", publisher: "Original Press", publishedAt: "2023", series: null, seriesIndex: null, description: "Original description.", subjects: ["Fiction"], identifiers: [] },
  sourceCoverUrl: null, overrides: { publisher: "Example Press" }, revision: 1,
  basedOnContentHash: books[0].contentHash!, sourceChanged: false, coverOverride: null,
};

function snapshot(patch: Partial<CatalogBrowserSnapshot> = {}): CatalogBrowserSnapshot {
  return {
    loadState: "ready", serviceStatus: { available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" },
    profiles: [profile], rootsByProfile: new Map([[profile.id, [root]]]), filters: initialLibraryFilters(profile.id), facets: EMPTY_CATALOG_FILTERS,
    page: { items: books, total: 3, limit: 24, offset: 0 }, booksState: "ready", stale: false, liveUpdatesConnected: true,
    settingsSaving: false, settingsRefreshing: false, settingsConflict: false, settingsDirty: false, rescanningRootIds: new Set(),
    sendBusy: false, kindleStatus: new Map([[books[0].id, "confirmed"], [books[1].id, "not-on-kindle"], [books[2].id, "possible"]]),
    kindleStatusCountsByProfile: new Map([[profile.id, { confirmed: 1, possible: 1, notOnKindle: 1, unknown: 0 }]]),
    kindleInventory: {
      deviceLabel: "Kindle", scannedAt: "2026-09-14T09:00:00Z", completeness: "complete", total: 2, truncated: false,
      metadata: { status: "complete", eligible: 2, enriched: 2, failed: 0, skipped: 0, truncated: false }, matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [{ id: "mtp-theme", filename: "The First Journey.azw3", title: books[0].title, authors: books[0].authors, size: 1024, managed: false, bookId: books[0].id, match: "confirmed" }],
    },
    kindleInventoryOffset: 0, layout: "grid", selectedBookIds: new Set(), bulkActionBusy: false,
    sendQueueState: "ready", sendQueueOpen: false, sendQueueBusy: false,
    seriesState: "idle", seriesQuery: "", seriesSort: "name", smartShelves: [], smartShelvesState: "ready", shelfManagerOpen: false,
    sidebarShelfOrder: { profileId: profile.id, revision: 1, shelfIds: [...BUILT_IN_SHELF_IDS] }, sidebarShelfOrderState: "ready",
    annotations: new Map(), healthState: "ready", healthBooks: new Map(), healthFilter: { type: "all", severity: "all", ignored: false },
    metadataLookupState: "ready", metadataLookupBusy: false, activityOpen: false, activityEvents: [],
    ...patch,
  };
}

function readyState(): AppState {
  return { ...initialAppState(), secureContext: true, webUsbAvailable: true, device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } }, selfTest: { kind: "passed", byteLength: 1012 }, catalogInventoryState: "ready" };
}

function render(name: string, patch: Partial<CatalogBrowserSnapshot> = {}, state = readyState(), alerts = ""): ThemeContrastFixture {
  const page = snapshot(patch);
  const diagnostics = page.filters.view === "settings"
    ? renderKindleDeviceContents(page, state.device.kind === "ready", state.catalogInventoryState)
    : "";
  return { name, html: `<div class="library-app-shell">${renderLibraryPrototype(state, page, alerts, diagnostics)}</div>` };
}

const providers: NonNullable<CatalogBrowserSnapshot["coverProviderSettings"]> = {
  loadState: "ready", busy: false, editing: false,
  googleBooks: { provider: "google-books", configured: false, maskedKey: null, revision: 0, status: "not-configured", lastTestedAt: null, errorCode: null },
  hardcover: { provider: "hardcover", configured: true, maskedKey: "••••••••", revision: 1, status: "working", lastTestedAt: null, errorCode: null },
};

const editor: CatalogMetadataEditorState = {
  profileId: profile.id, bookId: books[0].id, title: books[0].title, loadState: "ready", data: metadata,
  draftOverrides: metadata.overrides, busy: false,
  coverSearch: { provider: "open-library", query: "The First Journey", loadState: "ready", items: [{ candidateId: "cover-theme", title: "The First Journey", authors: ["Alex Author"], publishedAt: "2024", identifiers: ["isbn:9780000000002"], thumbnailUrl: `/api/profiles/${profile.id}/books/${books[0].id}/cover` }] },
  metadataSearch: {
    provider: "hardcover", terms: { title: books[0].title, author: "Alex Author" }, loadState: "ready", selectedCandidateId: "metadata-theme", selectedFields: new Set(["series", "seriesIndex"]), includeCover: false,
    items: [{ provider: "hardcover", candidateId: "metadata-theme", confidence: "high", metadata: { title: books[0].title, authors: [...books[0].authors], series: "The Journey", seriesIndex: 1, publisher: "Example Press" } },
      { provider: "hardcover", candidateId: "metadata-alternative", confidence: "medium", metadata: { title: "The First Journey: A Novel", authors: [...books[0].authors], series: "Journey Stories", seriesIndex: 1 } },
      { provider: "hardcover", candidateId: "metadata-unrelated", confidence: "low", metadata: { title: "Another Journey", authors: ["Another Author"] } }],
  },
};

const hardcoverBooks: HardcoverBook[] = books.map((book, index) => ({ id: index + 100, title: book.title, authors: [...book.authors], identifiers: [], url: `https://hardcover.app/books/theme-${index}`, coverUrl: null, releaseYear: 2024, series: [{ id: 10, name: "The Journey", position: index + 1 }] }));
const hardcoverPage: HardcoverLibrarySeriesPage = {
  id: 10, name: "The Journey", offset: 0, limit: 100, hasMore: true,
  books: hardcoverBooks.map((book, index) => ({ ...book, position: index + 1, library: { status: (["in-library", "possible", "missing"] as const)[index], books: index === 2 ? [] : [{ id: books[index].id, title: book.title, available: true, coverUrl: null }] } })),
};

function healthIssue(type: CatalogHealthIssue["type"], index: number): CatalogHealthIssue {
  return { version: 1, signature: `issue-theme-${index}`, profileId: profile.id, type, severity: index === 2 ? "error" : "info", reasonCode: type, bookIds: [books[index].id], sourceIds: [`source-${index}`], rootIds: [root.id], displayLabels: [books[index].title], currentAvailable: index !== 2, lastObservedAt: "2026-09-14T09:00:00Z", disposition: { ignored: false, preferredBookId: null, revision: 0, retryCount: 0, lastRetryAt: null } };
}

/** Call in a browser (or jsdom), then insert one fixture at a time into the DOM.
 * Load production CSS in its normal order; set data-theme on the document root.
 * Opening details/hidden provider bodies is left to the audit harness. */
export function themeContrastFixtures(): readonly ThemeContrastFixture[] {
  const base = snapshot();
  const settings = { filters: { ...base.filters, view: "settings" as const }, settingsLibraryId: profile.id, settingsDraft: settingsDraftFromProfile(profile, [root]), coverProviderSettings: providers };
  const details: NonNullable<CatalogBrowserSnapshot["bookDetails"]> = { profileId: profile.id, bookId: books[0].id, loadState: "ready", book: books[0], data: metadata, hardcover: { loadState: "ready", books: hardcoverBooks, selectedBookId: 100, seriesOpen: false, selectedSeriesId: 10, seriesState: "ready", seriesPage: hardcoverPage } };
  const issues = [healthIssue("missing-cover", 0), healthIssue("suspected-duplicate", 1), healthIssue("unavailable-source", 2)];
  const queue: NonNullable<CatalogBrowserSnapshot["sendQueue"]> = {
    profileId: profile.id, revision: 1, total: 2, totalSourceBytes: 3072,
    entries: books.slice(0, 2).map((book, index) => ({ profileId: profile.id, bookId: book.id, rank: index, queuedContentHash: book.contentHash!, queuedPresentationVersion: "v1", createdAt: "2026-09-14T08:00:00Z", updatedAt: "2026-09-14T08:00:00Z", book, sourceState: index ? "source-changed" : "ready" })),
  };
  const metadataJob: MetadataLookupJob = {
    id: "lookup-theme", profileId: profile.id, provider: "hardcover", status: "completed", revision: 1, entriesIncluded: true,
    total: 3, pending: 0, ready: 2, failed: 1, cancelled: 0, noResults: 0, createdAt: "2026-09-14T08:00:00Z", updatedAt: "2026-09-14T09:00:00Z",
    entries: books.map((book, index) => ({ jobId: "lookup-theme", bookId: book.id, rank: index, status: index === 2 ? "failed" : "ready", attempts: 1,
      candidates: index === 2 ? [] : editor.metadataSearch.items.map((candidate) => ({ ...candidate, metadata: { ...candidate.metadata, title: book.title } })),
      errorCode: index === 2 ? "provider-rate-limited" : null, acceptedAt: null, updatedAt: "2026-09-14T09:00:00Z" })),
  };
  return [
    render("dashboard-active-shelf", { activeShelf: { id: "builtin-recent", name: "Recently added", builtIn: true, query: { version: 1 } } }),
    render("dashboard-list-selected", { layout: "list", selectedBookIds: new Set(books.map((book) => book.id)) }),
    render("dashboard-list-busy", { layout: "list", selectedBookIds: new Set(books.map((book) => book.id)), bulkActionBusy: true }),
    render("dashboard-list-disconnected", { layout: "list", selectedBookIds: new Set(books.map((book) => book.id)) }, { ...readyState(), device: { kind: "disconnected" } }),
    render("dashboard-empty-filter", { filters: { ...base.filters, query: "No matching title" }, page: { items: [], total: 0, limit: 24, offset: 0 } }),
    render("kobo-connected", { activeReader: "kobo", kobo: { status: "ready", profileId: profile.id, statuses: base.kindleStatus, countsByProfile: base.kindleStatusCountsByProfile } }),
    render("kobo-recovery", { activeReader: "kobo", kobo: { status: "error", profileId: profile.id, statuses: new Map(), countsByProfile: new Map(), message: "A transfer was interrupted. Check your device before continuing.", recovery: [{ filename: "ShelfSend-The-First-Journey.epub", bytes: 1024, sha256: "0".repeat(64) }] } }),
    render("settings-providers", settings),
    render("settings-provider-edit", { ...settings, coverProviderSettings: { ...providers, editing: true, editingProvider: "hardcover", error: "The token could not be verified. Try again." } }),
    render("settings-delete-confirmation", { ...settings, confirmDeleteLibraryId: profile.id }),
    render("settings-stale-inventory", { ...settings, kindleInventory: { ...base.kindleInventory!, completeness: "last-seen", metadata: { status: "partial", eligible: 2, enriched: 1, failed: 1, skipped: 0, truncated: false }, matching: { status: "partial", matchedProfiles: 0, failedProfiles: 1 } } }, { ...readyState(), device: { kind: "disconnected" }, catalogInventoryState: "idle" }),
    render("manage-shelves", { shelfManagerOpen: true, smartShelves: [{ id: "shelf_theme", profileId: profile.id, name: "Weekend reading", query: { version: 1 }, pinnedRank: 0, revision: 1, serverCount: 3, createdAt: "2026-09-14", updatedAt: "2026-09-14" }] }),
    render("batch-transfer", { pendingBookId: books[1].id, pendingBook: books[1], sendBusy: true, sendPhase: "sending", sendProgress: 48, sendMessage: "Sending your book…", sendCancellable: true, batchTransfer: { id: "batch-theme", position: 2, total: 3, verifiedBooks: [{ id: books[0].id, title: books[0].title }], retryBooks: [] } }),
    ...(["sending", "complete", "failed"] as const).map((phase) => render(`inline-transfer-${phase}`, { pendingBookId: books[1].id, pendingBook: books[1], sendBusy: phase === "sending", sendPhase: phase, sendProgress: phase === "complete" ? 100 : 48, sendCancellable: phase === "sending", sendMessage: phase === "failed" ? "Transfer stopped. Reconnect and try again." : phase === "complete" ? "Sent to Kindle" : "Sending your book…" })),
    render("batch-transfer-failed", { pendingBookId: books[1].id, pendingBook: books[1], sendPhase: "failed", sendProgress: 48, sendMessage: "The connection was interrupted. Reconnect and try again.", batchTransfer: { id: "batch-theme", position: 2, total: 3, verifiedBooks: [{ id: books[0].id, title: books[0].title }], retryBooks: [{ id: books[1].id, title: books[1].title }], failedBook: { id: books[1].id, title: books[1].title } } }),
    render("remove-confirmation", { pendingRemoval: { profileId: profile.id, targets: [{ itemId: "mtp-theme", bookId: books[0].id, title: books[0].title, filename: "The First Journey.azw3", size: 1024 }] } }),
    render("update-confirmation", { pendingUpdate: { book: books[0], priorFilename: "The First Journey.azw3" } }),
    render("update-in-progress", { pendingUpdate: { book: books[0], priorFilename: "The First Journey.azw3" }, sendBusy: true, sendPhase: "verifying", sendProgress: 72, sendMessage: "Verifying the updated book…" }),
    render("update-failed", { pendingUpdate: { book: books[0], priorFilename: "The First Journey.azw3", error: "The connection was interrupted. Reconnect before trying again." }, sendPhase: "failed" }),
    render("send-queue", { sendQueueOpen: true, sendQueue: queue }),
    render("book-details", { bookDetails: details }),
    render("book-details-possible", { bookDetails: details, kindleStatus: new Map([[books[0].id, "possible"]]), kindleInventory: { ...base.kindleInventory!, items: [{ ...base.kindleInventory!.items[0], match: "possible" }] } }),
    render("metadata-cover-results", { metadataEditor: editor, coverProviderSettings: providers }),
    render("metadata-cover-errors", { metadataEditor: { ...editor, error: "This book changed. Review your choices before saving.", coverSearch: { ...editor.coverSearch, loadState: "error", error: "Cover search is unavailable. Try again." }, metadataSearch: { ...editor.metadataSearch, loadState: "error", error: "The provider could not be reached." } }, coverProviderSettings: providers }),
    render("hardcover-series", { bookDetails: { ...details, hardcover: { ...details.hardcover!, seriesOpen: true } } }),
    render("series-library", { filters: { ...base.filters, view: "series" }, seriesState: "ready", seriesDetail: { key: "the journey", name: "The Journey", books: { items: books, total: 3, limit: 1000, offset: 0 }, duplicateIndices: [], missingIntegerIndices: [4], unnumberedCount: 0 } }),
    render("needs-attention", { filters: { ...base.filters, view: "attention" }, healthBooks: new Map(books.map((book) => [book.id, book])), healthPage: { items: issues, total: 3, offset: 0, limit: 100, counts: { total: 3, active: 3, ignored: 0, byType: { "missing-cover": 1, "incomplete-metadata": 0, "metadata-parser-failure": 0, "low-confidence-provider-data": 0, "unavailable-source": 1, "suspected-duplicate": 1 }, bySeverity: { info: 2, warning: 0, error: 1 } } } }),
    render("bulk-metadata-job", { filters: { ...base.filters, view: "attention" }, healthBooks: new Map(books.map((book) => [book.id, book])),
      activeMetadataLookupJob: metadataJob, metadataLookupJobs: { items: [metadataJob, { ...metadataJob, id: "lookup-running", status: "running", entries: [], entriesIncluded: false, pending: 1 }], total: 2, limit: 20, offset: 0 },
      hardcoverBulkReview: { jobId: metadataJob.id, selections: new Map([[books[0].id, { candidateId: "metadata-theme", replaceExisting: true, reviewedBook: books[0] }]]), errors: new Map([[books[1].id, "Review the existing series before replacing it."]]), busy: false, summary: "Choose which series information to apply." },
    }),
    render("activity", { activityOpen: true, activityEvents: [{ version: 1, id: "theme-failure", kind: "failure", at: "2026-09-14T08:00:00Z", tone: "error", title: "Transfer stopped", detail: "Reconnect your device to try again.", profileId: profile.id, bookId: books[0].id, acknowledged: false }] }),
    render("match-review", { kindleInventory: { ...base.kindleInventory!, items: [{ ...base.kindleInventory!.items[0], match: "possible", candidates: [{ profileId: profile.id, bookId: books[0].id, reason: "Title and author comparison", evidence: { tier: "title-author", inventoryCompleteness: "complete", ambiguous: false, candidateCount: 1, comparisons: { title: "match", authors: "match", identifiers: "different", filename: "different", size: "unavailable" }, strongerProofUnavailable: "No exact association was found for this file." } }] }] }, matchReview: { itemId: "mtp-theme", requestedBookId: books[0].id, loadState: "ready", books: new Map([[books[0].id, books[0]]]), busy: false } }),
    render("onboarding", { onboarding: { step: "welcome" } }),
    render("notices", {}, readyState(), '<div class="notice info"><strong>Library is checking for updates</strong><span>Your books are still available.</span><button type="button">Show all books</button></div><div class="notice warning"><strong>Device disconnected</strong><span>Reconnect your device to continue.</span><button type="button">Reconnect</button></div><div class="notice error"><strong>Transfer needs attention</strong><span>Review the interrupted transfer.</span><button type="button">Review</button></div>'),
  ];
}
