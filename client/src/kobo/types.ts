/** Browser-only mounted-drive contracts. Handles never leave this transport. */
export interface KoboIdentity {
  readonly profileId: string;
  readonly bookId: string;
  readonly contentHash: string;
  readonly presentationVersion: string;
  readonly title: string;
}

export interface KoboManagedIdentity {
  readonly identityHash: string;
  readonly artifactHash: string;
}

export interface KoboInventoryEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly lastModified: number;
  readonly managed?: KoboManagedIdentity;
}

export interface KoboInventory {
  readonly entries: readonly KoboInventoryEntry[];
  readonly complete: boolean;
  readonly scannedAt: string;
}

export interface KoboTransferResult {
  readonly filename: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly alreadyPresent: boolean;
}

export interface KoboRecoveryRecord {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface KoboWritable {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type KoboHandle = KoboDirectoryHandle | KoboFileHandle;

export interface KoboFileHandle {
  readonly kind: "file";
  readonly name: string;
  isSameEntry(other: KoboHandle): Promise<boolean>;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean; mode?: "exclusive" }): Promise<KoboWritable>;
}

export interface KoboDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  isSameEntry(other: KoboHandle): Promise<boolean>;
  queryPermission?(options?: { mode: "readwrite" }): Promise<PermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<KoboDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<KoboFileHandle>;
  entries(): AsyncIterableIterator<[string, KoboHandle]>;
  removeEntry(name: string): Promise<void>;
}

export interface KoboConnectOptions {
  readonly picker?: (options: { mode: "readwrite"; id: string }) => Promise<KoboDirectoryHandle>;
  readonly signal?: AbortSignal;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Tests may omit the browser Web Lock with null; production always requires it. */
  readonly locks?: Pick<LockManager, "request"> | null;
}

export interface KoboSendOptions {
  readonly signal?: AbortSignal;
  /** Percent is below 100 until close and full SHA-256 read-back verification. */
  readonly onProgress?: (percent: number) => void;
}
