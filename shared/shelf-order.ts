import { MAX_PINNED_SMART_SHELVES_PER_PROFILE } from "./catalog-contracts.js";

/** Hidden/disabled built-ins retain their place without losing durable intent. */
export const BUILT_IN_SHELF_IDS = [
  "builtin-read-books",
  "builtin-recent",
  "builtin-not-on-kindle",
  "builtin-favorites",
  "builtin-want-to-read",
  "builtin-missing-cover",
] as const;

export const MAX_SIDEBAR_SHELF_IDS = BUILT_IN_SHELF_IDS.length + MAX_PINNED_SMART_SHELVES_PER_PROFILE;

/** Preserve known order, prune removed shelves, and append newly available ones. */
export function normalizeShelfSidebarOrder(
  savedIds: readonly string[],
  availableIds: readonly string[],
): string[] {
  const remaining = new Set(availableIds);
  const ordered: string[] = [];
  for (const id of savedIds) {
    if (remaining.delete(id)) ordered.push(id);
  }
  return [...ordered, ...remaining];
}
