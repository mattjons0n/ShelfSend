import { AppError } from "../app-error";
import type { ConversionOverrides } from "../api/conversion-overrides";
import type { CatalogApi, CatalogBook, CatalogKindleStatus, CatalogKindleStatusCounts, CatalogMatchIndexEntry } from "../catalog-client";
import type { CatalogSendRequest, CatalogTransferUpdate } from "../catalog-browser";
import type { CatalogKoboState } from "../reader-ui";
import { koboIdentityHash } from "./device";
import { prepareKoboArtifact } from "./prepare";
import type { KoboIdentity, KoboInventory, KoboInventoryEntry, KoboRecoveryRecord, KoboSendOptions, KoboTransferResult } from "./types";

/** No raw reader files, handles, or inventory are sent to the catalog server. */
export interface KoboCatalogDevice {
  readonly closed: boolean;
  readonly recoveryRecords: readonly KoboRecoveryRecord[];
  scan(signal?: AbortSignal): Promise<KoboInventory>;
  verifyEntry(entry: KoboInventoryEntry, signal?: AbortSignal): Promise<boolean>;
  send(blob: Blob, identity: KoboIdentity, options?: KoboSendOptions): Promise<KoboTransferResult>;
  acknowledgeRecovery(): void;
  disconnect(): void;
}

export interface KoboCatalogHooks {
  state(state: CatalogKoboState): void;
  progress(update: CatalogTransferUpdate): void;
}

const MAX_INDEX_ENTRIES = 20_000;
const MAX_VERIFIED_FILES = 2_000;
const MAX_VERIFIED_BYTES = 1024 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 10 * 60_000;

function version(book: { contentHash?: string; presentationVersion?: string }): string {
  return `${book.contentHash?.toLowerCase()}:${(book.presentationVersion ?? book.contentHash)?.toLowerCase()}`;
}

function identity(profileId: string, entry: CatalogMatchIndexEntry): KoboIdentity {
  return { profileId, bookId: entry.bookId, contentHash: entry.contentHash,
    presentationVersion: entry.presentationVersion ?? entry.contentHash, title: entry.title };
}

function filenameKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/(?:\.kepub)?\.epub$/u, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function counts(statuses: ReadonlyMap<string, CatalogKindleStatus>): CatalogKindleStatusCounts {
  const result = { confirmed: 0, possible: 0, notOnKindle: 0, unknown: 0 };
  for (const status of statuses.values()) result[status === "not-on-kindle" ? "notOnKindle" : status]++;
  return result;
}

/** Reads can be abandoned safely. Device writes must settle through the
 * transport's own cancellation/cleanup before releasing its operation lock. */
function read<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class KoboCatalogSession {
  readonly #abort = new AbortController();
  #snapshot: CatalogKoboState = { status: "scanning", supported: true, statuses: new Map(), countsByProfile: new Map() };
  #index = new Map<string, CatalogMatchIndexEntry>();
  #profileId?: string;
  #refreshing?: Promise<void>;
  #requestedProfile?: string;
  #busy = false;
  #closed = false;
  constructor(readonly api: CatalogApi, readonly device: KoboCatalogDevice, readonly hooks: KoboCatalogHooks) {}

  get busy(): boolean { return this.#busy || this.#refreshing !== undefined; }
  get closed(): boolean { return this.#closed || this.device.closed; }
  get snapshot(): CatalogKoboState { return this.#snapshot; }

  #emit(patch: Partial<CatalogKoboState>): void {
    this.#snapshot = { ...this.#snapshot, ...patch, recovery: this.device.recoveryRecords };
    if (!this.#closed) this.hooks.state(this.#snapshot);
  }

  refresh(profileId: string | undefined): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!profileId) {
      if (!this.busy) {
        this.#profileId = undefined;
        this.#index.clear();
        this.#emit({ status: "ready", profileId: undefined, statuses: new Map(), countsByProfile: new Map(),
          message: "Kobo connected. Choose or create a library to compare its books." });
      }
      return Promise.resolve();
    }
    this.#requestedProfile = profileId;
    if (this.#busy) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    const operation = (async () => {
      while (this.#requestedProfile && !this.closed) {
        const selected = this.#requestedProfile;
        this.#requestedProfile = undefined;
        await this.#refresh(selected);
      }
    })();
    this.#refreshing = operation;
    void operation.finally(() => { if (this.#refreshing === operation) this.#refreshing = undefined; });
    return operation;
  }

  async #refresh(profileId: string): Promise<void> {
    this.#emit({ status: "scanning", message: "Checking books on Kobo…" });
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new Error("Kobo comparison took too long. Try Refresh.")), OPERATION_TIMEOUT_MS);
    const signal = AbortSignal.any([this.#abort.signal, timer.signal]);
    try {
      const index = await read(this.api.getMatchIndex(profileId, signal), signal);
      if (index.profileId !== profileId || index.entries.length > MAX_INDEX_ENTRIES) {
        throw new Error("The library could not be compared safely. Refresh the library and try again.");
      }
      const inventory = await read(this.device.scan(signal), signal);
      const managed = new Map<string, KoboInventoryEntry[]>();
      const unmanagedNames = new Set<string>();
      for (const entry of inventory.entries) {
        if (entry.managed) managed.set(entry.managed.identityHash, [...(managed.get(entry.managed.identityHash) ?? []), entry]);
        else if (/\.epub$/iu.test(entry.name)) unmanagedNames.add(filenameKey(entry.name));
      }
      const statuses = new Map<string, CatalogKindleStatus>();
      let verifiedFiles = 0;
      let verifiedBytes = 0;
      for (const book of index.entries) {
        signal.throwIfAborted();
        if (book.sourceFormat.toLowerCase() !== "epub") { statuses.set(book.bookId, "unknown"); continue; }
        const matches = managed.get(await koboIdentityHash(identity(profileId, book))) ?? [];
        let status: CatalogKindleStatus = inventory.complete ? "not-on-kindle" : "unknown";
        if (matches.length) {
          status = "unknown";
          // Multiple copies with the same identity are not an unambiguous
          // presence claim; the transport likewise refuses to choose one.
          for (const entry of matches.length === 1 ? matches : []) {
            if (verifiedFiles >= MAX_VERIFIED_FILES || verifiedBytes + entry.size > MAX_VERIFIED_BYTES) break;
            verifiedFiles++;
            verifiedBytes += entry.size;
            if (await read(this.device.verifyEntry(entry, signal), signal)) { status = "confirmed"; break; }
          }
        } else if (unmanagedNames.has(filenameKey(book.sourceFilename)) || unmanagedNames.has(filenameKey(book.title))) {
          status = "possible";
        }
        statuses.set(book.bookId, status);
      }
      signal.throwIfAborted();
      this.#profileId = profileId;
      this.#index = new Map(index.entries.map((book) => [book.bookId, book]));
      this.#emit({ status: "ready", profileId, statuses, countsByProfile: new Map([[profileId, counts(statuses)]]),
        message: this.device.recoveryRecords.length ? "An interrupted transfer needs your review before sending."
          : inventory.complete ? "Kobo connected. Safely eject it from your computer when you finish."
            : "Some folders could not be checked. Refresh before sending books with unknown status." });
    } catch (error) {
      if (!this.closed) this.#emit({ status: "error", message: error instanceof Error ? error.message : "Kobo could not be checked. Reconnect and try again." });
    } finally { clearTimeout(timeout); }
  }

  async send(request: CatalogSendRequest): Promise<void> {
    if (this.closed || this.busy || this.#snapshot.status !== "ready" || this.device.recoveryRecords.length) {
      throw new AppError("INVALID_STATE", "Connect Kobo and finish checking its books before sending.");
    }
    const compared = this.#index.get(request.book.id);
    if (this.#profileId !== request.profileId || !compared || request.book.profileId !== request.profileId
      || version(request.book) !== version(compared)) {
      throw new AppError("CATALOG_SOURCE_CHANGED", "This book changed. Refresh the Kobo comparison before sending.");
    }
    const status = this.#snapshot.statuses.get(request.book.id);
    if (status !== "not-on-kindle" && status !== "confirmed") {
      throw new AppError("INVALID_STATE", status === "possible"
        ? "A file with this name is already on Kobo. Check it on your computer before sending another copy."
        : "Kobo presence is unknown for this book. Refresh the reader before sending.");
    }
    this.#busy = true;
    const timeoutAbort = new AbortController();
    const timeout = setTimeout(() => timeoutAbort.abort(new Error("Kobo transfer timed out.")), OPERATION_TIMEOUT_MS);
    const signal = AbortSignal.any([this.#abort.signal, timeoutAbort.signal, ...(request.cancelSignal ? [request.cancelSignal] : [])]);
    const progress = this.hooks.progress;
    progress({ phase: "preparing", progress: 0, message: "Preparing your EPUB…", cancellable: true });
    let committed = false;
    try {
      signal.throwIfAborted();
      const book = await read(this.api.getBook(request.profileId, request.book.id, signal), signal);
      this.#assertBook(book, compared, request.profileId);
      let overrides: ConversionOverrides | undefined;
      if (book.metadataEdited || book.coverEdited) {
        if (!this.api.getBookMetadata) throw new Error("Update the catalog server before sending edited books.");
        const metadata = await read(this.api.getBookMetadata(request.profileId, book.id, signal), signal);
        if (metadata.book.id !== book.id || metadata.book.profileId !== request.profileId
          || metadata.sourceChanged || metadata.revision !== book.metadataRevision
          || metadata.basedOnContentHash.toLowerCase() !== compared.contentHash.toLowerCase()
          || version(metadata.book) !== version(compared)) throw new Error("The book edits changed. Refresh before sending.");
        overrides = { ...metadata.overrides };
        if (metadata.coverOverride) {
          if (!this.api.getBookCover) throw new Error("The edited cover cannot be loaded. Update the catalog server.");
          const cover = await read(this.api.getBookCover(request.profileId, book.id, signal), signal);
          if (cover.size !== metadata.coverOverride.byteLength || cover.type !== metadata.coverOverride.mediaType) {
            throw new Error("The edited cover changed. Refresh the library before sending.");
          }
          overrides = { ...overrides, cover: { blob: cover, mediaType: metadata.coverOverride.mediaType } };
        } else if (book.coverEdited) {
          throw new Error("The edited cover is no longer available. Refresh the library before sending.");
        }
      }
      const source = await read(this.api.getBookSource(request.profileId, book.id, signal), signal);
      if ((source.contentLength !== undefined && source.contentLength !== book.size)
        || (source.etag && source.etag.toLowerCase() !== `"sha256-${compared.contentHash.toLowerCase()}"`)
        || (source.presentationVersion && source.presentationVersion.toLowerCase() !== (compared.presentationVersion ?? compared.contentHash).toLowerCase())) {
        throw new Error("The source changed while loading. Refresh before sending.");
      }
      const prepared = await prepareKoboArtifact(book, source.blob, { signal, overrides });
      // A user may have copied a book to the mounted drive while the source
      // was downloading. Recheck hints before handing off to the transport's
      // exact identity/read-back checks; a filename is never strong evidence.
      const currentInventory = await read(this.device.scan(signal), signal);
      const identityHash = await koboIdentityHash(identity(request.profileId, compared));
      const copies = currentInventory.entries.filter((entry) => entry.managed?.identityHash === identityHash);
      const currentPresence: CatalogKindleStatus | undefined = !currentInventory.complete || copies.length > 1 ? "unknown"
        : copies.length === 0 && currentInventory.entries.some((entry) => !entry.managed && /\.epub$/iu.test(entry.name)
          && [filenameKey(book.sourceFilename), filenameKey(book.title)].includes(filenameKey(entry.name))) ? "possible" : undefined;
      if (currentPresence) {
        const statuses = new Map(this.#snapshot.statuses).set(book.id, currentPresence);
        this.#emit({ statuses, countsByProfile: new Map([[request.profileId, counts(statuses)]]) });
        throw new Error(currentPresence === "possible"
          ? "A file with this name appeared on Kobo. Check it on your computer before sending another copy."
          : "The Kobo could not be compared completely, or contains duplicate copies. Refresh and inspect its books before sending.");
      }
      // Also catch an initially unedited book gaining its first overlay while preparing.
      this.#assertBook(await read(this.api.getBook(request.profileId, book.id, signal), signal), compared, request.profileId);
      signal.throwIfAborted();
      const result = await this.device.send(prepared.blob, identity(request.profileId, compared), {
        signal, onProgress: (value) => progress({ phase: value >= 95 ? "verifying" : "sending",
          progress: Math.min(99, 15 + value * 0.84), message: value >= 95 ? "Checking the copied book…" : "Sending to Kobo…", cancellable: true }),
      });
      committed = true;
      const statuses = new Map(this.#snapshot.statuses).set(book.id, "confirmed" as const);
      this.#emit({ statuses, countsByProfile: new Map([[request.profileId, counts(statuses)]]) });
      progress({ phase: "complete", progress: 100, message: result.alreadyPresent ? "Already on Kobo" : "Sent to Kobo", cancellable: false });
    } catch (error) {
      const cancelled = signal.aborted && !this.device.recoveryRecords.length && !committed;
      const message = cancelled ? "Transfer cancelled. No new book was left on Kobo."
        : error instanceof Error ? error.message : "The book could not be sent. Reconnect Kobo and try again.";
      if (this.device.recoveryRecords.length || this.device.closed) this.#emit({ status: "error", message });
      progress({ phase: cancelled ? "cancelled" : "failed", message, cancellable: false });
      throw new AppError(cancelled ? "TRANSFER_CANCELLED" : "CATALOG_REQUEST_FAILED", message);
    } finally {
      clearTimeout(timeout);
      this.#busy = false;
      if (this.#requestedProfile) void this.refresh(this.#requestedProfile);
    }
  }

  #assertBook(book: CatalogBook, compared: CatalogMatchIndexEntry, profileId: string): void {
    if (book.id !== compared.bookId || book.profileId !== profileId || book.available === false
      || book.format.toLowerCase() !== "epub" || version(book) !== version(compared)) {
      throw new AppError("CATALOG_SOURCE_CHANGED", "This book changed or is not an available EPUB. Refresh before sending to Kobo.");
    }
  }

  acknowledgeRecovery(): Promise<void> {
    if (this.busy) return Promise.resolve();
    this.device.acknowledgeRecovery();
    return this.refresh(this.#profileId);
  }

  disconnect(): void {
    this.#closed = true;
    this.#abort.abort(new DOMException("Kobo disconnected", "AbortError"));
    this.device.disconnect();
  }
}
