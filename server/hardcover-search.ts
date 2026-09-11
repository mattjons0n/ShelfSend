import type { MetadataCandidateSearchTerms } from "../shared/catalog-contracts.js";
import { normalizeKindleMetadataIdentifier, normalizeKindleMetadataWords } from "../shared/kindle-metadata-normalization.js";

export interface HardcoverTitleVariant {
  title: string;
  kind: "original" | "series-suffix" | "series-prefix";
  series?: string;
  position?: number;
}

interface BookEvidence {
  title: string;
  authors: readonly string[];
  identifiers: readonly string[];
  series: readonly { name: string; position: number | null }[];
}

export interface HardcoverMatchEvidence {
  kind: "isbn" | "title-author" | "cleaned-title-author-series" | "title" | "cleaned-title" | "author" | "none";
  rank: number;
  strong: boolean;
  variant?: HardcoverTitleVariant;
}

export function hardcoverIsbn(value: string | undefined): string | null {
  const normalized = normalizeKindleMetadataIdentifier(value ?? "");
  return /^(?:\d{9}[\dX]|\d{13})$/u.test(normalized) ? normalized : null;
}

function seriesKey(value: string): string {
  return normalizeKindleMetadataWords(value).replace(/\s+(?:series|trilogy|saga|cycle)$/u, "");
}

function position(value: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const number = Number(value);
    return number <= 1_000_000 ? number : undefined;
  }
  // Accept canonical Roman numerals only, not arbitrary uppercase title words.
  if (!/^(?=[MDCLXVI]+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/u.test(value)) return undefined;
  const values: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  return [...value].reduce((sum, digit, index) => sum + (values[digit]! < (values[value[index + 1]!] ?? 0) ? -values[digit]! : values[digit]!), 0);
}

/** Query-only variants: never mutate the source or remove an arbitrary subtitle.
 * A bare numbered/Roman prefix needs corroboration from the series suffix;
 * without one, require an explicit named-series Book/Volume prefix. */
export function hardcoverTitleVariants(terms: MetadataCandidateSearchTerms): HardcoverTitleVariant[] {
  const title = (terms.title ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  const variants: HardcoverTitleVariant[] = [{ title, kind: "original" }];
  if (!title || !terms.author?.trim()) return variants;
  const add = (variant: HardcoverTitleVariant): void => {
    if (variant.title.length >= 2 && !variants.some((item) => normalizeKindleMetadataWords(item.title) === normalizeKindleMetadataWords(variant.title))) variants.push(variant);
  };
  const suffix = /^(.*?)\s*\((.+?)\s+(?:book|volume|vol\.?|#)\s*(\d+(?:\.\d+)?|[ivxlcdm]+)\)\s*$/iu.exec(title);
  let base = title;
  let hint: { series: string; position: number } | undefined;
  if (suffix) {
    const number = position(suffix[3]!.toUpperCase());
    const series = suffix[2]!.replace(/[,;:\s]+$/gu, "");
    if (number !== undefined && seriesKey(series)) {
      base = suffix[1]!.trim();
      hint = { series, position: number };
      add({ title: base, kind: "series-suffix", ...hint });
    }
  }
  const prefix = /^(.+?)\s+(?:(book|volume|vol\.?)\s+)?(\d+(?:\.\d+)?|[ivxlcdm]+)\s*:\s*(.+)$/iu.exec(base);
  if (prefix) {
    const number = position(prefix[3]!.toUpperCase());
    const series = prefix[1]!.trim();
    const corroborated = hint ? number === hint.position && seriesKey(series) === seriesKey(hint.series) : Boolean(prefix[2]);
    if (number !== undefined && seriesKey(series) && corroborated) add({ title: prefix[4]!.trim(), kind: "series-prefix", series, position: number });
  }
  return variants.slice(0, 3);
}

/** Cleaned matches carry explicit series/volume corroboration. They never lower
 * the existing ISBN or exact-title/author automatic-selection requirements. */
export function hardcoverMatchEvidence(
  terms: MetadataCandidateSearchTerms,
  book: BookEvidence,
  variants = hardcoverTitleVariants(terms),
): HardcoverMatchEvidence {
  const isbn = hardcoverIsbn(terms.identifier);
  if (isbn && book.identifiers.some((value) => hardcoverIsbn(value) === isbn)) return { kind: "isbn", rank: 100, strong: true };
  const title = normalizeKindleMetadataWords(book.title);
  const author = normalizeKindleMetadataWords(terms.author ?? "");
  const authorMatches = Boolean(author && book.authors.some((value) => normalizeKindleMetadataWords(value) === author));
  const originalMatches = Boolean(title && title === normalizeKindleMetadataWords(terms.title ?? ""));
  if (originalMatches && authorMatches) return { kind: "title-author", rank: 90, strong: true };
  const cleaned = variants.find((variant) => variant.kind !== "original" && title && title === normalizeKindleMetadataWords(variant.title));
  if (cleaned && authorMatches && book.series.some((series) => series.position === cleaned.position && seriesKey(series.name) === seriesKey(cleaned.series ?? ""))) {
    return { kind: "cleaned-title-author-series", rank: 80, strong: true, variant: cleaned };
  }
  if (originalMatches) return { kind: "title", rank: 30, strong: false };
  if (cleaned) return { kind: "cleaned-title", rank: authorMatches ? 25 : 15, strong: false, variant: cleaned };
  return authorMatches ? { kind: "author", rank: 10, strong: false } : { kind: "none", rank: 0, strong: false };
}
