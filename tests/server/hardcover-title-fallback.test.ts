import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverProviderClient } from "../../server/cover-providers.js";
import type { MetadataCandidateSearchTerms } from "../../shared/catalog-contracts.js";

const TITLE = "E-Day III: Dark Moon (E-Day Trilogy Book 3)";
const AUTHOR = "Nicholas Sansbury Smith";
const ISBN = "9798434681247";
const TERMS = { title: TITLE, author: AUTHOR, identifier: "ASIN:B09KS6PMGF" };
const QUERIES = [TITLE, "E-Day III: Dark Moon", "Dark Moon"].map((title) => `${title} ${AUTHOR}`);
const book = (id: number, title: string, author = AUTHOR, position = 3, series = "E-Day") => ({
  id, title, slug: id === 1098689 ? "dark-moon-2022" : `book-${id}`, release_year: 2022, image: null,
  contributions: [{ contribution: null, author: { name: author } }],
  book_series: [{ series_id: 88, position, series: { name: series } }],
  editions: [{ isbn_13: ISBN }],
});
const target = book(1098689, "Dark Moon");
const unrelated = { ...book(13, "The Batman Chronicles (1995-2001) #13", "Bill Finger", 13, "Batman"), editions: [] };
type Mode = "discovery" | "metadata";
type Request = { query: string; variables: Record<string, unknown> };
const dataResponse = (data: unknown) => new Response(JSON.stringify({ data }));

function fixture(options: {
  ids?: (query: string, index: number) => number[];
  books?: ReturnType<typeof book>[];
  isbnBooks?: ReturnType<typeof book>[];
  intercept?: (request: Request, searchIndex: number) => Response | undefined;
} = {}) {
  let now = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const requests: Request[] = [];
  const searches: string[] = [];
  const rows = options.books ?? [unrelated, target];
  const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    now += 1_000;
    const request = JSON.parse(String(init?.body)) as Request;
    requests.push(request);
    const intercepted = options.intercept?.(request, searches.length);
    if (intercepted) return intercepted;
    // This suite exercises the fallback when Hardcover has no matching ASIN.
    if (request.query.includes("ByAsin")) return dataResponse({ editions: [] });
    if (request.query.includes("ByIsbn")) return dataResponse({ editions: (options.isbnBooks ?? []).map((item) => ({ isbn_13: ISBN, book: item })) });
    if (request.query.includes("SeriesSearch")) {
      const query = String(request.variables.query);
      searches.push(query);
      return dataResponse({ search: { ids: options.ids?.(query, searches.length - 1) ?? (query === QUERIES[2] ? [13, 1098689, 1098689] : [13, 13]), error: null } });
    }
    const ids = request.variables.ids as number[];
    return dataResponse({ books: rows.filter((item) => ids.includes(item.id)) });
  });
  return { client: new CoverProviderClient(fetcher, undefined, 1_000, "token"), requests, searches, fetcher };
}

async function lookup(mode: Mode, client: CoverProviderClient, terms: MetadataCandidateSearchTerms = TERMS, signal?: AbortSignal) {
  if (mode === "discovery") {
    const result = await client.lookupHardcoverBook(terms, signal);
    return { ids: result.books.map((item) => item.id), matchedBookId: result.matchedBookId, books: result.books, metadata: [] };
  }
  const result = await client.searchMetadata("hardcover", terms, 12, signal);
  return { ids: result.map((item) => Number(/^book-(\d+)-/u.exec(item.candidateId)?.[1])), matchedBookId: null, books: [], metadata: result };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("ranks a cleaned discovery match first but does not auto-select after a truncated search", async () => {
  const otherBooks = Array.from({ length: 21 }, (_, index) => book(100 + index, `Unrelated ${index}`, "Another Author", 1, "Another Series"));
  const { client, searches } = fixture({
    ids: (query) => query === QUERIES[2] ? [target.id] : otherBooks.map((item) => item.id),
    books: [...otherBooks, target],
  });
  const result = await client.lookupHardcoverBook(TERMS);
  expect(result.books[0]?.id).toBe(target.id);
  expect(result.books).toHaveLength(20);
  expect(result.matchedBookId).toBeNull();
  expect(searches).toEqual(QUERIES);
});

describe.each<Mode>(["discovery", "metadata"])("Hardcover conservative title fallback (%s)", (mode) => {
  it("finds the real decorated E-Day title despite irrelevant nonempty results and ranks the clean match first", async () => {
    const { client, searches, requests } = fixture();
    const result = await lookup(mode, client);
    expect(result.ids[0]).toBe(1098689);
    expect(result.ids.filter((id) => id === 1098689)).toHaveLength(1);
    expect(searches).toEqual(QUERIES);
    expect(requests.some((request) => request.query.includes("ByIsbn"))).toBe(false);
    if (mode === "discovery") {
      expect(result.matchedBookId).toBe(1098689);
      expect(result.books[0]).toMatchObject({ title: "Dark Moon", url: "https://hardcover.app/books/dark-moon-2022", series: [{ name: "E-Day", position: 3 }] });
    } else {
      expect(result.metadata[0]).toMatchObject({ confidence: "high", metadata: { title: "Dark Moon", authors: [AUTHOR], series: "E-Day", seriesIndex: 3 } });
    }
    const detailIds = requests.flatMap((request) => Array.isArray(request.variables.ids) ? request.variables.ids as number[] : []);
    expect(detailIds).toEqual([13, 1098689]);
  });

  it("continues from empty results, retaining the author in every fallback query", async () => {
    const { client, searches } = fixture({ ids: (query) => query === QUERIES[2] ? [1098689] : [] });
    const result = await lookup(mode, client);
    expect(result.ids).toEqual([1098689]);
    expect(searches).toEqual(QUERIES);
    expect(searches.every((query) => query.endsWith(AUTHOR))).toBe(true);
  });

  it("keeps successful ISBN lookup first without any text queries", async () => {
    const { client, searches, requests } = fixture({ isbnBooks: [target] });
    const result = await lookup(mode, client, { ...TERMS, identifier: ISBN });
    expect(result.ids).toEqual([1098689]);
    expect(searches).toEqual([]);
    expect(requests).toHaveLength(1);
    if (mode === "discovery") expect(result.matchedBookId).toBe(1098689);
    else expect(result.metadata[0]?.confidence).toBe("high");
  });

  it("does not add fallback queries after an exact original-title and author success", async () => {
    const { client, searches } = fixture({ ids: () => [1098689], books: [book(1098689, TITLE)] });
    const result = await lookup(mode, client);
    expect(searches).toEqual([QUERIES[0]]);
    if (mode === "discovery") expect(result.matchedBookId).toBe(1098689);
    else expect(result.metadata[0]?.confidence).toBe("high");
  });

  it("keeps a same-title, different-author result from becoming an automatic or high-confidence match", async () => {
    const { client, searches } = fixture({ ids: (query) => query === QUERIES[2] ? [21] : [], books: [book(21, "Dark Moon", "Another Author")] });
    const result = await lookup(mode, client);
    expect(result.ids).toContain(21);
    expect(searches).toEqual(QUERIES);
    if (mode === "discovery") expect(result.matchedBookId).toBeNull();
    else expect(result.metadata.every((item) => item.confidence !== "high")).toBe(true);
  });

  it("preserves multiple clean-title matches as choices rather than selecting the first book", async () => {
    const { client, searches } = fixture({ ids: (query) => query === QUERIES[2] ? [1098689, 22] : [], books: [target, book(22, "Dark Moon")] });
    const result = await lookup(mode, client);
    expect(result.ids).toEqual([1098689, 22]);
    expect(searches).toEqual(QUERIES);
    if (mode === "discovery") expect(result.matchedBookId).toBeNull();
  });

  it.each([
    { position: 2, series: "E-Day" },
    { position: 3, series: "Another Series" },
  ])("requires consistent series and volume evidence for cleaned-title selection: %j", async ({ position, series }) => {
    const { client } = fixture({ ids: (query) => query === QUERIES[2] ? [23] : [], books: [book(23, "Dark Moon", AUTHOR, position, series)] });
    const result = await lookup(mode, client);
    expect(result.ids).toContain(23);
    if (mode === "discovery") expect(result.matchedBookId).toBeNull();
    else expect(result.metadata[0]?.confidence).not.toBe("high");
  });

  it.each(["1984", "Catch-22", "World War II: A History", "Dark Moon: A Novel", "The City (A Novel)", "Book 3: A History of Publishing"])("does not destructively simplify the legitimate title %s", async (title) => {
    const { client, searches } = fixture({ ids: () => [] });
    await lookup(mode, client, { title, author: AUTHOR });
    expect(searches).toEqual([`${title} ${AUTHOR}`]);
  });

  it("does not guess which volume is meant when the prefix and suffix disagree", async () => {
    const title = "E-Day II: Dark Moon (E-Day Trilogy Book 3)";
    const { client, searches } = fixture({ ids: () => [1098689] });
    const result = await lookup(mode, client, { title, author: AUTHOR });
    expect(searches).not.toContain(`Dark Moon ${AUTHOR}`);
    if (mode === "discovery") expect(result.matchedBookId).toBeNull();
    else expect(result.metadata.every((item) => item.confidence !== "high")).toBe(true);
  });

  it("bounds text searches to three and fetches each repeated book identity only once", async () => {
    const { client, searches, requests } = fixture({ ids: () => [13, 13] });
    const result = await lookup(mode, client);
    expect(searches).toEqual(QUERIES);
    expect(searches).toHaveLength(3);
    expect(new Set(searches).size).toBe(searches.length);
    expect(result.ids).toEqual([13]);
    expect(requests.filter((request) => Array.isArray(request.variables.ids))).toHaveLength(1);
    expect(requests.length).toBeLessThanOrEqual(6);
  });

  it.each([[429, "provider_rate_limited"], [503, "provider_unavailable"]] as const)("propagates HTTP %s from a fallback instead of calling it no match", async (status, code) => {
    const { client, searches } = fixture({
      ids: () => [],
      intercept: (request, searchIndex) => request.query.includes("SeriesSearch") && searchIndex === 1 ? new Response("provider failed", { status }) : undefined,
    });
    await expect(lookup(mode, client)).rejects.toMatchObject({ code });
    expect(searches).toHaveLength(1);
  });

  it("stops cancelled fallbacks before sending another provider request", async () => {
    const controller = new AbortController();
    const { client, requests } = fixture({ ids: () => { controller.abort(); return []; } });
    await expect(lookup(mode, client, TERMS, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(2); // Exact ASIN miss, then cancelled text search.
  });
});
