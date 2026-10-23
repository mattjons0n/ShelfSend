import type { CatalogBrowserSnapshot } from "./catalog-browser";
import type { CatalogBook, CatalogKindleStatus, CatalogKindleStatusCounts } from "./catalog-client";
import type { KoboInventory } from "./kobo/types";
import type { KindleCoverItem } from "./kindle-cover-presenter";

const driveDisplayItems = new WeakMap<KoboInventory, readonly KindleCoverItem[]>();

export function kindleDriveItems(inventory: KoboInventory | undefined): readonly KindleCoverItem[] {
  if (!inventory) return [];
  let items = driveDisplayItems.get(inventory);
  if (!items) {
    items = inventory.entries.map(entry => ({ id: `drive:${entry.relativePath}`, filename: entry.name,
      title: entry.metadata?.title, authors: entry.metadata?.authors,
      path: entry.relativePath, size: entry.size, modificationDate: String(entry.lastModified) }));
    driveDisplayItems.set(inventory, items);
  }
  return items;
}

/** Display-only folder-reader projection. It is never MTP deletion authority. */
export interface CatalogKoboState {
  readonly reader?: "kobo" | "kindle-drive";
  readonly status: "disconnected" | "connecting" | "scanning" | "ready" | "error";
  readonly supported?: boolean;
  readonly message?: string;
  readonly profileId?: string;
  readonly inventory?: KoboInventory;
  readonly statuses: ReadonlyMap<string, CatalogKindleStatus>;
  readonly countsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts>;
  readonly recovery?: readonly { readonly filename: string; readonly bytes: number; readonly sha256: string }[];
}

export function isFolderReader(snapshot: CatalogBrowserSnapshot): boolean {
  return snapshot.activeReader === "kobo" || snapshot.activeReader === "kindle-drive";
}

export function readerName(snapshot: CatalogBrowserSnapshot): "Kindle" | "Kobo" {
  return snapshot.activeReader === "kobo" ? "Kobo" : "Kindle";
}

export function readerSupportsFormat(snapshot: CatalogBrowserSnapshot, format: string): boolean {
  return format.toUpperCase() === "EPUB" || (snapshot.activeReader !== "kobo" && format.toUpperCase() === "AZW3");
}

export function readerStatuses(snapshot: CatalogBrowserSnapshot): ReadonlyMap<string, CatalogKindleStatus> {
  if (!isFolderReader(snapshot)) return snapshot.kindleStatus;
  // The shared renderer falls back to a catalog book's Kindle field. Supply
  // explicit Unknown entries so that fallback never paints a Kobo check.
  const statuses = snapshot.kobo?.statuses ?? new Map<string, CatalogKindleStatus>();
  const missing = (snapshot.page?.items ?? []).filter((book) => !statuses.has(book.id));
  if (!missing.length) return statuses;
  return new Map<string, CatalogKindleStatus>([...statuses, ...missing.map((book) => [book.id, "unknown"] as const)]);
}

export function readerCounts(snapshot: CatalogBrowserSnapshot): ReadonlyMap<string, CatalogKindleStatusCounts> {
  return isFolderReader(snapshot) ? snapshot.kobo?.countsByProfile ?? new Map() : snapshot.kindleStatusCountsByProfile;
}

export function readerBookStatus(book: CatalogBook, snapshot: CatalogBrowserSnapshot): CatalogKindleStatus {
  // Never reuse a book's server/Kindle fallback status for a Kobo.
  return isFolderReader(snapshot) ? snapshot.kobo?.statuses.get(book.id) ?? "unknown" : snapshot.kindleStatus.get(book.id) ?? book.kindleStatus ?? "unknown";
}

export function koboReady(snapshot: CatalogBrowserSnapshot, profileId = snapshot.filters.profileId): boolean {
  return snapshot.kobo?.status === "ready"
    && !snapshot.kobo.recovery?.length
    && profileId !== undefined
    && snapshot.kobo.countsByProfile.has(profileId);
}

export function readerComparisonComplete(snapshot: CatalogBrowserSnapshot, profileId = snapshot.filters.profileId): boolean {
  return isFolderReader(snapshot) ? koboReady(snapshot, profileId)
    : snapshot.kindleInventory?.completeness === "complete"
      && snapshot.kindleInventory.matching?.status === "complete"
      && profileId !== undefined && snapshot.kindleStatusCountsByProfile.has(profileId);
}
