import type {
  HardcoverLibraryMatch,
  HardcoverLibrarySeriesPage,
  HardcoverSeriesPage,
} from "../shared/hardcover-contracts.js";
import { normalizeKindleMetadataWords } from "../shared/kindle-metadata-normalization.js";
import { CatalogDatabaseError, MAX_LIBRARY_PRESENCE_ENTRIES, type CatalogDatabase, type LibraryPresenceCandidate } from "./catalog-database.js";
import { hardcoverAsin, hardcoverMatchEvidence, hardcoverTitleVariants } from "./hardcover-search.js";

export const MAX_HARDCOVER_LIBRARY_MATCHES_PER_BOOK = 100;
export const MAX_HARDCOVER_LIBRARY_ASINS = MAX_LIBRARY_PRESENCE_ENTRIES;
const MAX_LIBRARY_MATCH_BYTES = 2 * 1024 * 1024;
type Index = Map<string, Set<number>>;
type LocalBook = HardcoverLibraryMatch["books"][number];

function add(index: Index, key: string, book: number): void {
  if (!key) return;
  const values = index.get(key) ?? new Set<number>();
  values.add(book);
  index.set(key, values);
}

/** Valid ISBN-10 and ISBN-13 editions share one key; arbitrary numeric IDs do not. */
function isbnKey(value: string): string | null {
  const isbn = value.normalize("NFKC").trim()
    .replace(/^(?:urn:)?isbn(?:[-_ ]?(?:10|13))?\s*[:=]?\s*/iu, "")
    .replace(/[-\s]/gu, "").toUpperCase();
  if (/^\d{9}[\dX]$/u.test(isbn)) {
    const checksum = [...isbn].reduce((sum, digit, index) => sum + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
    if (checksum % 11 !== 0) return null;
    const base = `978${isbn.slice(0, 9)}`;
    const sum = [...base].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    return `${base}${(10 - sum % 10) % 10}`;
  }
  if (!/^97[89]\d{10}$/u.test(isbn)) return null;
  return [...isbn].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0 ? isbn : null;
}

function titleAuthorKeys(title: string, authors: string[]): string[] {
  const key = normalizeKindleMetadataWords(title);
  if (!key) return [];
  return authors.flatMap((author) => {
    const normalized = normalizeKindleMetadataWords(author);
    return normalized ? [`${key}\u0000${normalized}`] : [];
  });
}

function hits(index: Index, keys: Iterable<string | null>): Set<number> {
  const result = new Set<number>();
  for (const key of keys) if (key) for (const book of index.get(key) ?? []) result.add(book);
  return result;
}

function localIdentities(book: LibraryPresenceCandidate): Array<{ title: string; authors: string[] }> {
  return [{ title: book.title, authors: book.authors }, { title: book.sourceTitle, authors: book.sourceAuthors }];
}

/** Exact provider lookups only; this collection is never Kindle identity evidence. */
export function collectHardcoverLibraryAsins(
  database: CatalogDatabase,
  profileId: string,
  maxAsins = MAX_HARDCOVER_LIBRARY_ASINS,
): string[] {
  if (!Number.isSafeInteger(maxAsins) || maxAsins < 1 || maxAsins > MAX_HARDCOVER_LIBRARY_ASINS) {
    throw new CatalogDatabaseError("invalid_state", "Invalid Hardcover library ASIN limit.");
  }
  const asins = new Set<string>();
  database.visitLibraryPresenceCandidates(profileId, (candidate) => {
    for (const identifier of [...candidate.identifiers, ...candidate.sourceIdentifiers]) {
      const asin = hardcoverAsin(identifier);
      if (asin) asins.add(asin);
      if (asins.size > maxAsins) {
        throw new CatalogDatabaseError("too_large", "The library exceeds the Hardcover ASIN lookup limit.");
      }
    }
  });
  return [...asins].sort();
}

/** This is read-only selected-library ownership, never Kindle transfer or deletion evidence. */
export function enrichHardcoverSeries(
  database: CatalogDatabase,
  profileId: string,
  page: HardcoverSeriesPage,
): HardcoverLibrarySeriesPage {
  const byIsbn: Index = new Map();
  const byAsin: Index = new Map();
  const byTitleAuthor: Index = new Map();
  const byTitle: Index = new Map();
  const matches = page.books.map(() => ({ strong: [] as LocalBook[], possible: [] as LocalBook[] }));
  const authors = page.books.map((book) => new Set(book.authors.map(normalizeKindleMetadataWords).filter(Boolean)));
  for (const [index, book] of page.books.entries()) {
    for (const identifier of book.identifiers) {
      add(byIsbn, isbnKey(identifier) ?? "", index);
      add(byAsin, hardcoverAsin(identifier) ?? "", index);
    }
    for (const key of titleAuthorKeys(book.title, book.authors)) add(byTitleAuthor, key, index);
    add(byTitle, normalizeKindleMetadataWords(book.title), index);
  }
  let matchBytes = 0;
  database.visitLibraryPresenceCandidates(profileId, (candidate) => {
    const identities = localIdentities(candidate);
    const isbn = hits(byIsbn, [...candidate.identifiers, ...candidate.sourceIdentifiers].map(isbnKey));
    const asin = hits(byAsin, [...candidate.identifiers, ...candidate.sourceIdentifiers].map(hardcoverAsin));
    const titleAuthor = hits(byTitleAuthor, identities.flatMap((identity) => titleAuthorKeys(identity.title, identity.authors)));
    const title = hits(byTitle, identities.map((identity) => normalizeKindleMetadataWords(identity.title)));
    for (const identity of identities) {
      const variants = hardcoverTitleVariants({ title: identity.title, author: identity.authors.find((author) => author.trim()) });
      const cleaned = hits(byTitle, variants.filter((variant) => variant.kind !== "original")
        .map((variant) => normalizeKindleMetadataWords(variant.title)));
      for (const index of cleaned) {
        title.add(index);
        const providerBook = page.books[index]!;
        // Corroborate this roster row, not another series membership belonging
        // to the same provider book. Keep source/effective title-author pairs
        // together and feed the result through existing ISBN/ambiguity checks.
        const evidence = { ...providerBook, series: providerBook.series.filter((membership) =>
          membership.id === page.id && membership.position === providerBook.position
          && normalizeKindleMetadataWords(membership.name) === normalizeKindleMetadataWords(page.name)) };
        if (identity.authors.some((author) => hardcoverMatchEvidence({ title: identity.title, author }, evidence, variants)
          .kind === "cleaned-title-author-series")) titleAuthor.add(index);
      }
    }
    const candidates = new Set([...asin, ...isbn, ...title]);
    if (!candidates.size) return;
    const localAuthors = new Set(identities.flatMap((identity) => identity.authors.map(normalizeKindleMetadataWords)).filter(Boolean));
    // A unique edition ISBN can distinguish books with identical title/author
    // labels. When ISBN and title/author point to disjoint books, neither wins.
    const isbnIdentities = new Set([...isbn].map((index) => page.books[index]!.id));
    const asinIdentities = new Set([...asin].map((index) => page.books[index]!.id));
    const titleIdentities = new Set([...titleAuthor].map((index) => page.books[index]!.id));
    const disjoint = isbn.size > 0 && titleAuthor.size > 0 && ![...isbn].some((index) => titleAuthor.has(index));
    // A unique ASIN resolves a provider work without depending on the EPUB's
    // title. Competing exact identifiers cannot be resolved by weaker labels.
    // Preserve the older ISBN/title conflict rule when no ASIN is available.
    const identifierIdentities = new Set([...asinIdentities, ...isbnIdentities]);
    const preferred = asin.size ? asin : isbn.size ? isbn : titleAuthor;
    const ambiguous = asin.size ? identifierIdentities.size > 1
      : disjoint || (isbn.size ? isbnIdentities.size > 1 : titleIdentities.size > 1);
    const book: LocalBook = { id: candidate.id, title: candidate.title, available: candidate.available, coverUrl: candidate.coverUrl };
    for (const index of candidates) {
      const match = matches[index]!;
      if (match.strong.length + match.possible.length >= MAX_HARDCOVER_LIBRARY_MATCHES_PER_BOOK) {
        throw new CatalogDatabaseError("too_large", "A Hardcover book exceeds the local library match limit.");
      }
      // This conservative escaped-size estimate bounds repeated local details
      // before JSON serialization, even when several volumes share a claimant.
      matchBytes += 128 + 6 * (Buffer.byteLength(book.id) + Buffer.byteLength(book.title) + Buffer.byteLength(book.coverUrl ?? ""));
      if (matchBytes > MAX_LIBRARY_MATCH_BYTES) {
        throw new CatalogDatabaseError("too_large", "Hardcover library matches exceed the response byte limit.");
      }
      const authorConflict = (asin.has(index) || isbn.has(index)) && authors[index]!.size > 0 && localAuthors.size > 0
        && ![...authors[index]!].some((author) => localAuthors.has(author));
      const strong = preferred.has(index) && !ambiguous && !authorConflict;
      (strong ? match.strong : match.possible).push(book);
    }
  });
  return {
    ...page,
    books: page.books.map((book, index) => {
      const match = matches[index]!;
      const library: HardcoverLibraryMatch = match.strong.length
        ? { status: "in-library", books: match.strong }
        : match.possible.length ? { status: "possible", books: match.possible } : { status: "missing", books: [] };
      return { ...book, library };
    }),
  };
}
