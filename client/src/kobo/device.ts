import type {
  KoboConnectOptions, KoboDirectoryHandle, KoboFileHandle, KoboIdentity,
  KoboInventory, KoboInventoryEntry, KoboRecoveryRecord, KoboSendOptions,
  KoboTransferResult, KoboWritable,
} from "./types";

export const KOBO_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const KOBO_RECOVERY_STORAGE_KEY = "shelfsend-kobo-recovery-v1";
export const KOBO_MAX_INVENTORY_ENTRIES = 10_000;
const CHUNK_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_PATH = 1024;
const MANAGED_FOLDER = "ShelfSend";
const HASH = /^[a-f0-9]{64}$/u;
const MANAGED_NAME = /^(?:[a-zA-Z0-9-]{1,32}-)?ss-v1-([a-f0-9]{64})-([a-f0-9]{64})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.epub$/u;
const MAX_RECOVERY_RECORDS = 20;
type StoragePort = NonNullable<KoboConnectOptions["storage"]>;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Transfer cancelled.", "AbortError");
}

function notFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

function readableFilesystemError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name === "NotFoundError") return new Error("Kobo or one of its files is no longer available. Reconnect Kobo and refresh its books.");
  if (error.name === "NotAllowedError" || error.name === "SecurityError") return new Error("Kobo folder permission expired. Reconnect Kobo and allow folder access.");
  if (error.name === "NoModificationAllowedError") return new Error("The Kobo file is busy or read-only. Close other apps using Kobo, then reconnect.");
  if (error.name === "QuotaExceededError") return new Error("Kobo may be out of space. Free some space using your computer, then try again.");
  return error;
}

function validPart(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".."
    && !/[\\/\u0000-\u001f\u007f]/u.test(name);
}

async function digest(blob: Blob): Promise<string> {
  if (blob.size > KOBO_MAX_FILE_BYTES) throw new Error("This book exceeds the 200 MiB Kobo transfer limit.");
  const result = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Opaque profile/source/presentation identity; never a title or deletion authority. */
export async function koboIdentityHash(identity: KoboIdentity): Promise<string> {
  if (!identity.profileId || identity.profileId.length > 200 || !identity.bookId || identity.bookId.length > 200
    || !HASH.test(identity.contentHash.toLowerCase()) || !HASH.test(identity.presentationVersion.toLowerCase())) {
    throw new Error("Refresh the library before sending this book to Kobo.");
  }
  return digest(new Blob([JSON.stringify([
    "shelfsend-kobo-v1", identity.profileId, identity.bookId,
    identity.contentHash.toLowerCase(), identity.presentationVersion.toLowerCase(),
  ])]));
}

function managedName(name: string): { identityHash: string; artifactHash: string } | undefined {
  const match = MANAGED_NAME.exec(name);
  return match ? { identityHash: match[1], artifactHash: match[2] } : undefined;
}

function readRecovery(storage: StoragePort): KoboRecoveryRecord[] {
  const raw = storage.getItem(KOBO_RECOVERY_STORAGE_KEY);
  if (raw === null) return [];
  if (raw.length > 16_384) throw new Error("The Kobo recovery record could not be read. Inspect the ShelfSend folder before clearing recovery.");
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_RECORDS || value.some((record: unknown) => {
    if (!record || typeof record !== "object") return true;
    const item = record as Record<string, unknown>;
    return typeof item.filename !== "string" || !MANAGED_NAME.test(item.filename)
      || typeof item.sha256 !== "string" || !HASH.test(item.sha256)
      || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes)
      || item.bytes < 1 || item.bytes > KOBO_MAX_FILE_BYTES;
  })) throw new Error("The Kobo recovery record could not be read. Inspect the ShelfSend folder before clearing recovery.");
  return value as KoboRecoveryRecord[];
}

function recoveryWarning(filename?: string): Error {
  return new Error(filename
    ? `The transfer could not finish safely. Reconnect your Kobo and inspect ShelfSend/${filename}. Remove only that file if it is incomplete, then acknowledge the inspection.`
    : "A previous Kobo transfer needs checking. Inspect the listed file on that Kobo before sending another book.");
}

/**
 * Mounted-drive EPUB transport. No .kobo content is read or changed; its directory
 * handle is only a root-selection and same-session identity guard. All mutation
 * is confined to a fresh random filename under ShelfSend. No general Delete API.
 */
export class KoboDevice {
  readonly #root: KoboDirectoryHandle;
  readonly #marker: KoboDirectoryHandle;
  readonly #storage: StoragePort;
  #releaseLock: (() => void) | undefined;
  #closed = false;
  #sending = false;
  #recovery: KoboRecoveryRecord[] = [];
  #invalidRecovery = false;
  #folder: KoboDirectoryHandle | undefined;

  private constructor(root: KoboDirectoryHandle, marker: KoboDirectoryHandle, storage: StoragePort) {
    this.#root = root;
    this.#marker = marker;
    this.#storage = storage;
  }

  static async connect(options: KoboConnectOptions = {}): Promise<KoboDevice> {
    aborted(options.signal);
    const picker = options.picker ?? (globalThis as unknown as {
      showDirectoryPicker?: KoboConnectOptions["picker"];
    }).showDirectoryPicker;
    if (!picker) throw new Error("Kobo transfers need a desktop Chrome or Edge browser with folder access. Open ShelfSend there to connect.");
    // Invoke the picker before any awaited work, preserving the direct user gesture.
    const root = await picker({ mode: "readwrite", id: "shelfsend-kobo" });
    aborted(options.signal);
    let marker: KoboDirectoryHandle;
    try { marker = await root.getDirectoryHandle(".kobo"); }
    catch { throw new Error("Choose the main Kobo drive folder, not a book folder. It must contain the Kobo's .kobo folder."); }
    let storage: StoragePort;
    try { storage = options.storage ?? globalThis.localStorage; }
    catch { throw new Error("Browser storage is needed to keep Kobo transfers recoverable. Allow storage for ShelfSend and reconnect."); }
    if (!storage) throw new Error("Browser storage is needed to keep Kobo transfers recoverable. Allow storage for ShelfSend and reconnect.");
    const device = new KoboDevice(root, marker, storage);
    const locks = options.locks === null ? null : options.locks ?? globalThis.navigator?.locks;
    if (options.locks !== null && !locks) throw new Error("This browser cannot protect a Kobo transfer across tabs. Use desktop Chrome or Edge.");
    if (locks) {
      await new Promise<void>((resolve, reject) => {
        void locks.request("shelfsend-kobo-mounted-drive", { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) { reject(new Error("Kobo is already connected in another ShelfSend tab. Disconnect it there first.")); return; }
          if (options.signal?.aborted) { reject(new DOMException("Connection cancelled.", "AbortError")); return; }
          await new Promise<void>((release) => { device.#releaseLock = release; resolve(); });
        }).catch(reject);
      });
    }
    // Another tab may have interrupted a write before this lease was granted.
    // Read durable recovery only after owning the same-origin exclusive lock.
    try { device.#recovery = readRecovery(storage); }
    catch { device.#invalidRecovery = true; }
    try { await device.#validate(options.signal); }
    catch (error) { device.disconnect(); throw error; }
    return device;
  }

  get closed(): boolean { return this.#closed; }

  get recoveryRecords(): readonly KoboRecoveryRecord[] {
    return this.#invalidRecovery
      ? [{ filename: "ShelfSend folder (saved filename unavailable)", bytes: 0, sha256: "" }]
      : this.#recovery.map((record) => ({ ...record }));
  }

  /** Must be called only after the user explicitly confirms inspecting the old transfer. */
  acknowledgeRecovery(): void {
    if (this.#sending) throw new Error("Wait for the current Kobo transfer to finish before acknowledging recovery.");
    this.#storage.removeItem(KOBO_RECOVERY_STORAGE_KEY);
    if (this.#storage.getItem(KOBO_RECOVERY_STORAGE_KEY) !== null) throw new Error("Kobo recovery could not be cleared from browser storage.");
    this.#recovery = [];
    this.#invalidRecovery = false;
  }

  disconnect(): void {
    this.#closed = true;
    // An in-flight native write is awaited and cleaned up before the lock is released.
    if (!this.#sending) { this.#releaseLock?.(); this.#releaseLock = undefined; }
  }

  async #validate(signal?: AbortSignal, cleanup = false): Promise<void> {
    if (!cleanup && this.#closed) throw new Error("Reconnect your Kobo to continue.");
    if (!cleanup) aborted(signal);
    if (this.#root.queryPermission && await this.#root.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw new Error("Kobo folder permission expired. Reconnect your Kobo and allow folder access.");
    }
    let marker: KoboDirectoryHandle;
    try { marker = await this.#root.getDirectoryHandle(".kobo"); }
    catch (error) { throw readableFilesystemError(error); }
    if (!await marker.isSameEntry(this.#marker)) throw new Error("The Kobo folder changed. Reconnect your Kobo before continuing.");
    if (!cleanup) {
      aborted(signal);
      if (this.#closed) throw new Error("Reconnect your Kobo to continue.");
    }
  }

  async #getFolder(create: boolean, signal?: AbortSignal): Promise<KoboDirectoryHandle> {
    await this.#validate(signal);
    const folder = await this.#root.getDirectoryHandle(MANAGED_FOLDER, { create });
    if (this.#folder && !await folder.isSameEntry(this.#folder)) throw new Error("The Kobo book folder changed. Reconnect your Kobo before continuing.");
    this.#folder = folder;
    return folder;
  }

  async scan(signal?: AbortSignal): Promise<KoboInventory> {
    await this.#validate(signal);
    const entries: KoboInventoryEntry[] = [];
    let visited = 0;
    const visit = async (directory: KoboDirectoryHandle, prefix: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) throw new Error("The Kobo has folders too deep to check safely. Keep books within eight folder levels.");
      for await (const [name, handle] of directory.entries()) {
        aborted(signal);
        if (this.#closed) throw new Error("Reconnect your Kobo to continue.");
        if (++visited > KOBO_MAX_INVENTORY_ENTRIES) throw new Error("The Kobo has too many files to check safely (10,000 entry limit).");
        if (!validPart(name) || handle.name !== name) throw new Error("A Kobo filename could not be checked safely.");
        // Never traverse databases, hidden sidecars, or host operating-system metadata.
        if (name.startsWith(".") || /^(?:System Volume Information|\$RECYCLE\.BIN)$/iu.test(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (path.length > MAX_PATH) throw new Error("A Kobo folder path is too long to check safely.");
        if (handle.kind === "directory") await visit(handle, path, depth + 1);
        else if (/\.epub$/iu.test(name)) {
          const file = await handle.getFile();
          if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("A Kobo file size could not be checked safely.");
          const managed = prefix === MANAGED_FOLDER ? managedName(name) : undefined;
          entries.push({ name, relativePath: path, size: file.size, lastModified: file.lastModified, ...(managed ? { managed } : {}) });
        }
      }
    };
    try { await visit(this.#root, "", 0); }
    catch (error) { throw readableFilesystemError(error); }
    await this.#validate(signal);
    return { entries, complete: true, scannedAt: new Date().toISOString() };
  }

  /** Full byte verification of a current managed candidate, without rescanning the drive. */
  async verifyEntry(entry: KoboInventoryEntry, signal?: AbortSignal): Promise<boolean> {
    if (!entry.managed || entry.relativePath !== `${MANAGED_FOLDER}/${entry.name}`
      || !MANAGED_NAME.test(entry.name) || entry.size > KOBO_MAX_FILE_BYTES) return false;
    const parsed = managedName(entry.name)!;
    if (parsed.identityHash !== entry.managed.identityHash || parsed.artifactHash !== entry.managed.artifactHash) return false;
    await this.#validate(signal);
    try {
      const folder = await this.#getFolder(false, signal);
      const handle = await folder.getFileHandle(entry.name);
      const file = await handle.getFile();
      if (file.size !== entry.size || file.lastModified !== entry.lastModified || file.size < 4) return false;
      const hash = await digest(file);
      aborted(signal);
      const current = await folder.getFileHandle(entry.name);
      if (!await current.isSameEntry(handle)) return false;
      const after = await current.getFile();
      await this.#validate(signal);
      return after.size === file.size && after.lastModified === file.lastModified && hash === entry.managed.artifactHash;
    } catch (error) {
      if (notFound(error)) { await this.#validate(signal); return false; }
      throw readableFilesystemError(error);
    }
  }

  async find(identity: KoboIdentity, signal?: AbortSignal): Promise<{ status: "present" | "absent" | "unknown"; entry?: KoboInventoryEntry }> {
    const identityHash = await koboIdentityHash(identity);
    const inventory = await this.scan(signal);
    const candidates = inventory.entries.filter((entry) => entry.managed?.identityHash === identityHash);
    if (!candidates.length) return { status: inventory.complete ? "absent" : "unknown" };
    // More than one exact identity is ambiguous; no deletion/repair is inferred.
    if (candidates.length !== 1) return { status: "unknown" };
    return await this.verifyEntry(candidates[0], signal)
      ? { status: "present", entry: candidates[0] }
      : { status: "unknown", entry: candidates[0] };
  }

  #saveRecovery(records: KoboRecoveryRecord[]): void {
    if (records.length > MAX_RECOVERY_RECORDS) throw new Error("Too many interrupted Kobo transfers need inspection before sending.");
    try {
      if (records.length) {
        const serialized = JSON.stringify(records);
        this.#storage.setItem(KOBO_RECOVERY_STORAGE_KEY, serialized);
        if (this.#storage.getItem(KOBO_RECOVERY_STORAGE_KEY) !== serialized) throw new Error("not saved");
      } else {
        this.#storage.removeItem(KOBO_RECOVERY_STORAGE_KEY);
        if (this.#storage.getItem(KOBO_RECOVERY_STORAGE_KEY) !== null) throw new Error("not cleared");
      }
      this.#recovery = records;
    } catch {
      // A Storage implementation can persist and still throw. Do not trust the
      // old in-memory snapshot or start another write after an uncertain save.
      this.#invalidRecovery = true;
      throw new Error("Browser recovery storage is unavailable. No further Kobo transfers can start until storage is working.");
    }
  }

  async #cleanup(folder: KoboDirectoryHandle, handle: KoboFileHandle, filename: string): Promise<boolean> {
    try {
      await this.#validate(undefined, true);
      const currentFolder = await this.#root.getDirectoryHandle(MANAGED_FOLDER);
      if (!await currentFolder.isSameEntry(folder)) return false;
      let current: KoboFileHandle;
      try { current = await currentFolder.getFileHandle(filename); }
      catch (error) {
        if (!notFound(error)) return false;
        await this.#validate(undefined, true);
        return true;
      }
      if (!await current.isSameEntry(handle)) return false;
      await currentFolder.removeEntry(filename);
      try { await currentFolder.getFileHandle(filename); return false; }
      catch (error) {
        if (!notFound(error)) return false;
        await this.#validate(undefined, true);
        return true;
      }
    } catch { return false; }
  }

  async send(blob: Blob, identity: KoboIdentity, options: KoboSendOptions = {}): Promise<KoboTransferResult> {
    if (this.#sending) throw new Error("A Kobo transfer is already in progress.");
    this.#sending = true;
    let folder: KoboDirectoryHandle | undefined;
    let handle: KoboFileHandle | undefined;
    let writer: KoboWritable | undefined;
    let filename: string | undefined;
    let journaled = false;
    let ownsHandle = false;
    let committed = false;
    try {
      await this.#validate(options.signal);
      if (this.#invalidRecovery || this.#recovery.length) throw recoveryWarning();
      if (!Number.isSafeInteger(blob.size) || blob.size > KOBO_MAX_FILE_BYTES || blob.size < 4) {
        throw new Error("Kobo accepts EPUB files up to 200 MiB.");
      }
      const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 3 || header[3] !== 4) throw new Error("Only EPUB files can be sent to Kobo.");
      const identityHash = await koboIdentityHash(identity);
      const artifactHash = await digest(blob);
      const presence = await this.find(identity, options.signal);
      if (presence.status === "unknown") throw new Error("An existing Kobo copy has changed or appears more than once. Inspect it before sending again.");
      if (presence.status === "present" && presence.entry) {
        if (presence.entry.managed?.artifactHash !== artifactHash) throw new Error("The prepared book differs from its existing Kobo copy. Refresh and inspect the copy before sending.");
        options.onProgress?.(100);
        return { filename: presence.entry.name, relativePath: presence.entry.relativePath, bytes: blob.size, sha256: artifactHash, alreadyPresent: true };
      }
      options.onProgress?.(0);
      folder = await this.#getFolder(true, options.signal);
      const stem = identity.title.normalize("NFKD").replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32);
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `${stem ? `${stem}-` : ""}ss-v1-${identityHash}-${artifactHash}-${crypto.randomUUID()}.epub`;
        try { await folder.getFileHandle(candidate); }
        catch (error) {
          if (notFound(error)) { filename = candidate; break; }
          if (!(error instanceof Error) || error.name !== "TypeMismatchError") throw error;
        }
      }
      if (!filename) throw new Error("A new Kobo filename could not be reserved safely. Please try again.");
      await this.#validate(options.signal);
      this.#saveRecovery([{ filename, bytes: blob.size, sha256: artifactHash }]);
      journaled = true;
      handle = await folder.getFileHandle(filename, { create: true });
      const initial = await handle.getFile();
      // A racing existing nonempty file is never opened for writing or cleanup.
      if (initial.size !== 0) throw new Error("That Kobo filename already exists. No existing file was changed.");
      ownsHandle = true;
      await this.#validate(options.signal);
      if (!await (await folder.getFileHandle(filename)).isSameEntry(handle)) throw new Error("The Kobo file changed before transfer.");
      writer = await handle.createWritable({ keepExistingData: false, mode: "exclusive" });
      for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
        await this.#validate(options.signal);
        const chunk = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        aborted(options.signal);
        await writer.write(chunk);
        await this.#validate(options.signal);
        options.onProgress?.(Math.floor(Math.min(blob.size, offset + chunk.byteLength) / blob.size * 90));
      }
      await this.#validate(options.signal);
      await writer.close();
      writer = undefined;
      options.onProgress?.(95);
      await this.#validate(options.signal);
      const file = await handle.getFile();
      const entry: KoboInventoryEntry = {
        name: filename, relativePath: `${MANAGED_FOLDER}/${filename}`, size: file.size,
        lastModified: file.lastModified, managed: { identityHash, artifactHash },
      };
      if (file.size !== blob.size || !await this.verifyEntry(entry, options.signal)) throw new Error("The Kobo copy could not be verified. Its bytes did not match the book.");
      aborted(options.signal);
      this.#saveRecovery([]);
      journaled = false;
      committed = true;
      options.onProgress?.(100);
      return { filename, relativePath: entry.relativePath, bytes: file.size, sha256: artifactHash, alreadyPresent: false };
    } catch (error) {
      let abortedWriter = true;
      if (writer) {
        try { await writer.abort(); } catch { abortedWriter = false; }
      }
      if (journaled) {
        // Failed/uncertain native close/abort retains recovery; never delete while
        // a native writer might still complete against the same path.
        const cleaned = abortedWriter && ownsHandle && folder && handle && filename
          ? await this.#cleanup(folder, handle, filename) : false;
        if (!cleaned) throw recoveryWarning(filename);
        this.#saveRecovery([]);
      }
      if (committed) throw new Error("The Kobo copy was verified, but the display could not update. Refresh its inventory before sending again.");
      throw readableFilesystemError(error);
    } finally {
      this.#sending = false;
      if (this.#closed) { this.#releaseLock?.(); this.#releaseLock = undefined; }
    }
  }
}
