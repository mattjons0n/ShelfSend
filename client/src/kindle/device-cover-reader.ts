import { extractKindleBookCover, type KindleBookCover } from "./book-cover";
import type { KindleObjectStore, KindleOperationOptions, KindleStoredObjectInfo } from "./contracts";
import type { PseudonymousKindleIdentity } from "./device-identity";
import { exactKindleObjectInfoFromInventory, type KindleInventorySnapshot } from "./inventory";
import type { KindleCoverCache, KindleCoverCacheEvidence } from "./cover-cache";
import { isFatalTransportFailure } from "../error-diagnostics";

export const MAX_KINDLE_COVER_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_KINDLE_COVER_CONNECTION_BYTES = 256 * 1024 * 1024;

function sameObject(left: KindleStoredObjectInfo, right: KindleStoredObjectInfo): boolean {
  return left.handle === right.handle && left.storageId === right.storageId
    && left.objectFormat === right.objectFormat && left.protectionStatus === right.protectionStatus
    && left.compressedSize === right.compressedSize && left.parentHandle === right.parentHandle
    && left.associationType === right.associationType && left.filename === right.filename
    && left.modificationDate === right.modificationDate;
}

function exactCoverCandidate(inventory: KindleInventorySnapshot, handle: number): {
  readonly info: KindleStoredObjectInfo;
  readonly chain: readonly KindleStoredObjectInfo[];
  readonly relativePath: string;
} | undefined {
  if (inventory.status !== "complete") return undefined;
  const objects = inventory.objects.filter((object) => object.handle === handle);
  const object = objects[0];
  if (objects.length !== 1 || !object || object.kind !== "file" || object.metadataAdjusted
      || object.storageId !== inventory.storageId || object.associationType !== 0
      || object.objectFormat === 0x3001 || !/\.(azw3?|mobi|prc)$/iu.test(object.filename)
      || object.size <= 0 || object.size > MAX_KINDLE_COVER_OBJECT_BYTES) return undefined;

  const chain: KindleStoredObjectInfo[] = [];
  let current = object;
  const seen = new Set<number>();
  while (chain.length < 32) {
    const exact = exactKindleObjectInfoFromInventory(inventory, current.handle);
    if (!exact || current.metadataAdjusted || seen.has(current.handle)
        || current.storageId !== inventory.storageId || exact.storageId !== current.storageId
        || exact.filename !== current.filename || exact.compressedSize !== current.size
        || exact.objectFormat !== current.objectFormat || exact.associationType !== current.associationType
        || exact.protectionStatus !== current.protectionStatus || exact.parentHandle !== current.parentHandle
        || !current.filename || /[/\\\p{Cc}]/u.test(current.filename)
        || current.filename === "." || current.filename === ".."
        || inventory.objects.filter((entry) => entry.relativePath.toLowerCase() === current.relativePath.toLowerCase()).length !== 1) return undefined;
    seen.add(current.handle);
    chain.push(exact);
    if (current.parentHandle === inventory.documentsHandle) {
      if (current.depth !== 1 || current.relativePath !== current.filename) return undefined;
      return { info: chain[0]!, chain, relativePath: object.relativePath };
    }
    const parents = inventory.objects.filter((entry) => entry.handle === current.parentHandle);
    const parent = parents[0];
    if (parents.length !== 1 || !parent || parent.kind !== "folder"
        || parent.depth + 1 !== current.depth || `${parent.relativePath}/${current.filename}` !== current.relativePath) return undefined;
    current = parent;
  }
  return undefined;
}

/** A per-connection reader with its own optional-read budget; it never writes to MTP. */
export class KindleDeviceCoverReader {
  readonly #store: Pick<KindleObjectStore, "getObjectInfo" | "readObject">;
  readonly #cache: KindleCoverCache;
  readonly #identity?: PseudonymousKindleIdentity;
  #budgetedBytes = 0;

  constructor(
    store: Pick<KindleObjectStore, "getObjectInfo" | "readObject">,
    cache: KindleCoverCache,
    identity?: PseudonymousKindleIdentity,
  ) {
    this.#store = store;
    this.#cache = cache;
    this.#identity = identity;
  }

  async read(
    inventory: KindleInventorySnapshot,
    handle: number,
    options: KindleOperationOptions & { readonly aggregateTimeoutMs?: number; readonly cancelSignal?: AbortSignal },
    isCurrent: () => boolean,
  ): Promise<KindleBookCover | undefined> {
    const candidate = exactCoverCandidate(inventory, handle);
    if (!candidate) return undefined;
    const { info, chain, relativePath } = candidate;
    const startedAt = Date.now();
    const current = (): boolean => isCurrent() && !options.signal?.aborted && !options.cancelSignal?.aborted
      && Date.now() - startedAt < Math.min(options.aggregateTimeoutMs ?? 120_000, 120_000);
    // Navigation cancellation is advisory between commands. An in-flight full
    // GetObject must drain; aborting its USB response would poison the session.
    const ioOptions: KindleOperationOptions = {
      commandTimeoutMs: Math.min(options.commandTimeoutMs ?? 60_000, 60_000),
      inactivityTimeoutMs: Math.min(options.inactivityTimeoutMs ?? 15_000, 15_000),
    };
    const revalidate = async (): Promise<boolean> => {
      for (const expected of chain) {
        if (!current()) return false;
        if (!sameObject(expected, await this.#store.getObjectInfo(expected.handle, ioOptions))) return false;
      }
      return current();
    };
    const evidence: KindleCoverCacheEvidence | undefined = this.#identity ? {
      identity: this.#identity, storageId: info.storageId, relativePath, metadataAdjusted: false,
      objectFormat: info.objectFormat, size: info.compressedSize, modificationDate: info.modificationDate,
    } : undefined;
    try {
      if (!await revalidate()) return undefined;
      const cached = evidence ? await this.#cache.lookup(evidence).catch(() => undefined) : undefined;
      if (cached) return await revalidate() ? cached.cover : undefined;
      if (!current() || this.#budgetedBytes + info.compressedSize > MAX_KINDLE_COVER_CONNECTION_BYTES) return undefined;
      this.#budgetedBytes += info.compressedSize;
      const bytes = await this.#store.readObject(handle, { ...ioOptions, maxBytes: info.compressedSize });
      if (bytes.byteLength !== info.compressedSize || !await revalidate()) return undefined;
      const cover = extractKindleBookCover(bytes);
      if (evidence) await this.#cache.remember(evidence, cover).catch(() => undefined);
      return current() ? cover : undefined;
    } catch (error) {
      if (isFatalTransportFailure(error)) throw error;
      return undefined;
    }
  }
}
