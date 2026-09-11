import type { CatalogMetadataCandidate, EditableBookMetadata, MetadataCandidateSearchTerms } from "../shared/catalog-contracts.js";
import type { HardcoverBook, HardcoverBookLookup, HardcoverSeriesBook, HardcoverSeriesMembership, HardcoverSeriesPage } from "../shared/hardcover-contracts.js";
import { normalizeKindleMetadataIdentifier, normalizeKindleMetadataWords } from "../shared/kindle-metadata-normalization.js";

// Fixed queries verified against Hardcover's official schema and Searching guide.
// Search IDs are typed GraphQL values; no third-party search URLs or covers are followed.
const BOOK_FIELDS = `id title
  contributions(limit: 20) { contribution author { name } }
  book_series(limit: 20, order_by: {id: asc}) { series_id position series { name } }`;

export const HARDCOVER_ISBN_QUERY = `query ShelfSendSeriesByIsbn($isbn: String!, $limit: Int!) {
  editions(limit: $limit, order_by: {id: asc}, where: {_or: [{isbn_13: {_eq: $isbn}}, {isbn_10: {_eq: $isbn}}]}) {
    isbn_10 isbn_13 book { ${BOOK_FIELDS} }
  }
}`;

export const HARDCOVER_SEARCH_QUERY = `query ShelfSendSeriesSearch($query: String!, $limit: Int!) {
  search(query: $query, query_type: "book", fields: "title,author_names", weights: "5,2", typos: "2,1", per_page: $limit, page: 1) { ids error }
}`;

export const HARDCOVER_BOOKS_QUERY = `query ShelfSendSeriesBooks($ids: [Int!]!, $limit: Int!) {
  books(where: {id: {_in: $ids}}, limit: $limit) {
    ${BOOK_FIELDS}
    editions(limit: 20, order_by: {id: asc}) { isbn_10 isbn_13 }
  }
}`;

// Discovery is separate from metadata overlays: standalone books are valid results.
// Fields and ordering verified against Hardcover's official schema.graphql and
// GettingBooksInSeries.mdx. Discovery lookups retain choices; the series roster
// uses Hardcover's recommended single main book per volume (not a language guess).
const DISCOVERY_BOOK_FIELDS = `${BOOK_FIELDS}
  slug release_year image { url }
  editions(limit: 20, order_by: {id: asc}) { isbn_10 isbn_13 }`;

export const HARDCOVER_DISCOVERY_ISBN_QUERY = `query ShelfSendBookByIsbn($isbn: String!, $limit: Int!) {
  editions(limit: $limit, order_by: {id: asc}, where: {_or: [{isbn_13: {_eq: $isbn}}, {isbn_10: {_eq: $isbn}}]}) {
    isbn_10 isbn_13 book { ${DISCOVERY_BOOK_FIELDS} }
  }
}`;

export const HARDCOVER_DISCOVERY_BOOKS_QUERY = `query ShelfSendDiscoveryBooks($ids: [Int!]!, $limit: Int!) {
  books(where: {id: {_in: $ids}}, limit: $limit) { ${DISCOVERY_BOOK_FIELDS} }
}`;

export const HARDCOVER_SERIES_QUERY = `query ShelfSendSeriesRoster($seriesId: Int!, $limit: Int!, $offset: Int!) {
  series_by_pk(id: $seriesId) {
    id name
    book_series(
      limit: $limit, offset: $offset, distinct_on: position,
      order_by: [{position: asc_nulls_last}, {book: {users_count: desc_nulls_last}}, {id: asc}],
      where: {book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}}, compilation: {_eq: false}}
    ) {
      position book { ${DISCOVERY_BOOK_FIELDS} }
    }
  }
}`;

/** Slugs come from the provider; missing slugs use its documented ID redirect. */
export function hardcoverBookUrl(slug: unknown, id?: number): string | null {
  if (typeof slug !== "string" || slug.length > 500 || !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(slug)) {
    return hardcoverBookIds([id], 1).length ? `https://hardcover.app/id/book/${id}` : null;
  }
  return `https://hardcover.app/books/${encodeURIComponent(slug)}`;
}

export function hardcoverCoverUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048 || /\s|\\/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.pathname === "/") return null;
    // Both hosts are used by Hardcover's own homepage. Its image transformer
    // may wrap only an HTTPS asset URL from the same confirmed CDN.
    if (url.hostname === "assets.hardcover.app") return url.toString();
    if (url.hostname === "production-img.hardcover.app") {
      const source = url.searchParams.get("url");
      if (source && source.startsWith("https://assets.hardcover.app/") && hardcoverCoverUrl(source)) return url.toString();
    }
    return null;
  } catch { return null; }
}

function discoveryPosition(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

/** Null indicates malformed essential fields, not an empty or missing book. */
export function hardcoverDiscoveryBook(value: unknown): HardcoverBook | null {
  if (!record(value)) return null;
  const id = hardcoverBookIds([value.id], 1)[0];
  const title = text(value.title, 500);
  if (!id || !title || !Array.isArray(value.contributions) || !Array.isArray(value.book_series) || !Array.isArray(value.editions)) return null;
  const authors = [...new Set(value.contributions.slice(0, 20).flatMap((item) => {
    if (!record(item) || !record(item.author)) return [];
    const role = typeof item.contribution === "string" ? item.contribution.trim().toLowerCase() : "";
    const name = text(item.author.name, 300);
    return name && (!role || role === "author") ? [name] : [];
  }))];
  const identifiers = discoveryIdentifiers(value.editions);
  const series: HardcoverSeriesMembership[] = [];
  const seenMemberships = new Set<string>();
  for (const membership of value.book_series.slice(0, 20)) {
    if (!record(membership) || !record(membership.series)) return null;
    const seriesId = hardcoverBookIds([membership.series_id], 1)[0];
    const name = text(membership.series.name, 500);
    if (!seriesId || !name) return null;
    const position = discoveryPosition(membership.position);
    const key = `${seriesId}:${position}`;
    if (seenMemberships.has(key)) continue;
    seenMemberships.add(key);
    series.push({ id: seriesId, name, position });
  }
  return {
    id, title, authors, identifiers, series,
    url: hardcoverBookUrl(value.slug, id),
    coverUrl: record(value.image) ? hardcoverCoverUrl(value.image.url) : null,
    releaseYear: typeof value.release_year === "number" && Number.isInteger(value.release_year) && value.release_year >= 1 && value.release_year <= 9_999 ? value.release_year : null,
  };
}

function discoveryIdentifiers(editions: unknown[]): string[] {
  return [...new Set(editions.slice(0, 20).flatMap((edition) => {
    if (!record(edition)) return [];
    return [edition.isbn_10, edition.isbn_13].flatMap((value) => {
      const isbn = typeof value === "string" ? hardcoverIsbn(value) : null;
      return isbn ? [`ISBN:${isbn}`] : [];
    });
  }))].slice(0, 20);
}

/** Duplicate ISBN editions merge by book identity before ambiguity is assessed. */
export function hardcoverDiscoveryLookup(rows: unknown[], terms: MetadataCandidateSearchTerms, limit: number, editionRows = false, truncated = false): HardcoverBookLookup | null {
  const byId = new Map<number, HardcoverBook>();
  for (const row of rows.slice(0, limit + 1)) {
    const book = hardcoverDiscoveryBook(editionRows && record(row) ? row.book : row);
    if (!book) return null;
    if (editionRows) book.identifiers = [...new Set([...discoveryIdentifiers([row]), ...book.identifiers])].slice(0, 20);
    const existing = byId.get(book.id);
    if (existing) existing.identifiers = [...new Set([...existing.identifiers, ...book.identifiers])].slice(0, 20);
    else byId.set(book.id, book);
  }
  const books = [...byId.values()].slice(0, limit);
  const isbn = hardcoverIsbn(terms.identifier);
  const isbnMatches = isbn ? books.filter((book) => book.identifiers.some((value) => hardcoverIsbn(value) === isbn)) : [];
  const title = normalizeKindleMetadataWords(terms.title ?? "");
  const author = normalizeKindleMetadataWords(terms.author ?? "");
  const strong = isbnMatches.length ? isbnMatches : books.filter((book) => title && author && normalizeKindleMetadataWords(book.title) === title && book.authors.some((name) => normalizeKindleMetadataWords(name) === author));
  return { books, matchedBookId: !truncated && rows.length <= limit && strong.length === 1 ? strong[0]!.id : null };
}

/** Pagination consumes provider memberships, including duplicate rows. */
export function hardcoverDiscoverySeries(value: unknown, id: number, limit: number, offset: number): HardcoverSeriesPage | null {
  if (!record(value) || value.id !== id || !Array.isArray(value.book_series) || value.book_series.length > limit + 1) return null;
  const name = text(value.name, 500);
  if (!name) return null;
  const books: HardcoverSeriesBook[] = [];
  const seen = new Set<string>();
  for (const [index, row] of value.book_series.entries()) {
    if (!record(row)) return null;
    const book = hardcoverDiscoveryBook(row.book);
    if (!book) return null;
    const position = discoveryPosition(row.position);
    if (index >= limit) continue;
    const key = `${book.id}:${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    books.push({ ...book, position });
  }
  // The API sorts the complete roster before paging; this defensively preserves
  // numeric ordering within the page without converting null positions to zero.
  books.sort((left, right) => (left.position ?? Infinity) - (right.position ?? Infinity));
  return { id, name, books, offset, limit, hasMore: value.book_series.length > limit };
}

export function hardcoverIsbn(value: string | undefined): string | null {
  const normalized = normalizeKindleMetadataIdentifier(value ?? "");
  return /^(?:\d{9}[\dX]|\d{13})$/u.test(normalized) ? normalized : null;
}

export function hardcoverBookIds(value: unknown, limit: number): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647))].slice(0, limit)
    : [];
}

/** A membership is a separate review choice, never an automatically preferred series. */
export function hardcoverMetadataCandidates(
  rows: unknown[],
  terms: MetadataCandidateSearchTerms,
  limit: number,
  editionRows = false,
): CatalogMetadataCandidate[] {
  const results: CatalogMetadataCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 20)) {
    if (!record(row)) continue;
    const book = editionRows ? row.book : row;
    if (!record(book)) continue;
    const id = hardcoverBookIds([book.id], 1)[0];
    const title = text(book.title, 500);
    if (!id || !title) continue;
    const authors = Array.isArray(book.contributions) ? [...new Set(book.contributions.slice(0, 20).flatMap((item) => {
      if (!record(item) || !record(item.author)) return [];
      const role = typeof item.contribution === "string" ? item.contribution.trim().toLowerCase() : "";
      const name = text(item.author.name, 300);
      return name && (!role || role === "author") ? [name] : [];
    }))] : [];
    const editions = editionRows ? [row] : Array.isArray(book.editions) ? book.editions : [];
    const identifiers = [...new Set(editions.slice(0, 20).flatMap((edition) => {
      if (!record(edition)) return [];
      return [edition.isbn_10, edition.isbn_13].flatMap((value) => {
        const isbn = typeof value === "string" ? hardcoverIsbn(value) : null;
        return isbn ? [`ISBN:${isbn}`] : [];
      });
    }))].slice(0, 20);
    const metadata: Partial<EditableBookMetadata> = {
      title,
      ...(authors.length ? { authors } : {}),
      ...(identifiers.length ? { identifiers } : {}),
    };
    const memberships = Array.isArray(book.book_series) ? book.book_series.slice(0, 20) : [];
    for (const membership of memberships) {
      if (!record(membership) || !record(membership.series)) continue;
      const seriesId = hardcoverBookIds([membership.series_id], 1)[0];
      const series = text(membership.series.name, 500);
      if (!seriesId || !series) continue;
      const candidateId = `book-${id}-series-${seriesId}`;
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      const position = membership.position;
      results.push({
        provider: "hardcover",
        candidateId,
        confidence: confidence(terms, metadata),
        metadata: {
          ...metadata,
          series,
          seriesIndex: typeof position === "number" && Number.isFinite(position) && position >= 0 && position <= 1_000_000
            ? position : null,
        },
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function confidence(terms: MetadataCandidateSearchTerms, metadata: Partial<EditableBookMetadata>): CatalogMetadataCandidate["confidence"] {
  const isbn = hardcoverIsbn(terms.identifier);
  if (isbn && metadata.identifiers?.some((value) => normalizeKindleMetadataIdentifier(value) === isbn)) return "high";
  const title = normalizeKindleMetadataWords(terms.title ?? "");
  const author = normalizeKindleMetadataWords(terms.author ?? "");
  const titleMatches = !!title && title === normalizeKindleMetadataWords(metadata.title ?? "");
  const authorMatches = !!author && metadata.authors?.some((value) => normalizeKindleMetadataWords(value) === author);
  return titleMatches && authorMatches ? "high" : titleMatches || authorMatches ? "medium" : "low";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized && normalized.length <= maximum && !/\p{Cc}/u.test(normalized) ? normalized : null;
}
