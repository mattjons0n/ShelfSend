export function hardcoverIsbn(value: string | undefined): string | null {
  const recognized = /^(?:(?:urn:)?isbn(?:[-_ ]?1[03])?\s*[:=-]?\s*)?([\dX][\dX\s-]*)$/iu.exec((value ?? "").normalize("NFKC").trim());
  if (!recognized) return null;
  const normalized = recognized[1]!.replace(/[\s-]/gu, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/u.test(normalized) ? normalized : null;
}

/** Recognize explicitly typed ASINs, or Amazon's B-prefixed ebook identifiers.
 * Never strip arbitrary prefixes/punctuation: UUIDs are not ASIN evidence. */
export function hardcoverAsin(value: string | undefined): string | null {
  const normalized = (value ?? "").normalize("NFKC").trim().toUpperCase();
  const typed = /^(?:URN:)?ASIN:\s*([A-Z0-9]{10})$/u.exec(normalized);
  return typed?.[1] ?? (/^B[A-Z0-9]{9}$/u.test(normalized) ? normalized : null);
}

export function hardcoverLookupIdentifiers(identifiers: readonly string[]): { identifier?: string; asin?: string } {
  const identifier = identifiers.map(hardcoverIsbn).find((value) => value !== null);
  const asin = identifiers.map(hardcoverAsin).find((value) => value !== null);
  return { ...(identifier ? { identifier } : {}), ...(asin ? { asin } : {}) };
}
