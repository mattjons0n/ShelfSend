/** Grid width changes never shrink the typography or remove book metadata. */
export const LIBRARY_CARD_SIZE_MIN = 180;
export const LIBRARY_CARD_SIZE_MAX = 280;
export const LIBRARY_CARD_SIZE_STEP = 20;
export const LIBRARY_CARD_SIZE_DEFAULT = 220;

export const LIBRARY_PAGE_SIZES = [12, 24, 48, 96, 200] as const;

export function isLibraryCardSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= LIBRARY_CARD_SIZE_MIN
    && value <= LIBRARY_CARD_SIZE_MAX
    && (value - LIBRARY_CARD_SIZE_MIN) % LIBRARY_CARD_SIZE_STEP === 0;
}

export function normalizeLibraryCardSize(value: unknown): number {
  return isLibraryCardSize(value) ? value : LIBRARY_CARD_SIZE_DEFAULT;
}

export function isLibraryPageSize(value: unknown): value is typeof LIBRARY_PAGE_SIZES[number] {
  return typeof value === "number" && LIBRARY_PAGE_SIZES.some((size) => size === value);
}
