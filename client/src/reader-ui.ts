import type { CatalogBrowserSnapshot } from "./catalog-browser";
import type { CatalogBook, CatalogKindleStatus, CatalogKindleStatusCounts } from "./catalog-client";

/** Display-only Kobo projection. It is never a Kindle inventory or deletion authority. */
export interface CatalogKoboState {
  readonly status: "disconnected" | "connecting" | "scanning" | "ready" | "error";
  readonly supported?: boolean;
  readonly message?: string;
  readonly profileId?: string;
  readonly statuses: ReadonlyMap<string, CatalogKindleStatus>;
  readonly countsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts>;
  readonly recovery?: readonly { readonly filename: string; readonly bytes: number; readonly sha256: string }[];
}

export function isKoboReader(snapshot: CatalogBrowserSnapshot): boolean {
  return snapshot.activeReader === "kobo";
}

export function readerName(snapshot: CatalogBrowserSnapshot): "Kindle" | "Kobo" {
  return isKoboReader(snapshot) ? "Kobo" : "Kindle";
}

export function readerStatuses(snapshot: CatalogBrowserSnapshot): ReadonlyMap<string, CatalogKindleStatus> {
  if (!isKoboReader(snapshot)) return snapshot.kindleStatus;
  // The shared renderer falls back to a catalog book's Kindle field. Supply
  // explicit Unknown entries so that fallback never paints a Kobo check.
  const statuses = snapshot.kobo?.statuses ?? new Map<string, CatalogKindleStatus>();
  const missing = (snapshot.page?.items ?? []).filter((book) => !statuses.has(book.id));
  if (!missing.length) return statuses;
  return new Map<string, CatalogKindleStatus>([...statuses, ...missing.map((book) => [book.id, "unknown"] as const)]);
}

export function readerCounts(snapshot: CatalogBrowserSnapshot): ReadonlyMap<string, CatalogKindleStatusCounts> {
  return isKoboReader(snapshot) ? snapshot.kobo?.countsByProfile ?? new Map() : snapshot.kindleStatusCountsByProfile;
}

export function readerBookStatus(book: CatalogBook, snapshot: CatalogBrowserSnapshot): CatalogKindleStatus {
  // Never reuse a book's server/Kindle fallback status for a Kobo.
  return isKoboReader(snapshot) ? snapshot.kobo?.statuses.get(book.id) ?? "unknown" : snapshot.kindleStatus.get(book.id) ?? book.kindleStatus ?? "unknown";
}

export function koboReady(snapshot: CatalogBrowserSnapshot, profileId = snapshot.filters.profileId): boolean {
  return snapshot.kobo?.status === "ready"
    && !snapshot.kobo.recovery?.length
    && profileId !== undefined
    && snapshot.kobo.countsByProfile.has(profileId);
}

export function readerComparisonComplete(snapshot: CatalogBrowserSnapshot, profileId = snapshot.filters.profileId): boolean {
  return isKoboReader(snapshot) ? koboReady(snapshot, profileId)
    : snapshot.kindleInventory?.completeness === "complete"
      && snapshot.kindleInventory.matching?.status === "complete"
      && profileId !== undefined && snapshot.kindleStatusCountsByProfile.has(profileId);
}
