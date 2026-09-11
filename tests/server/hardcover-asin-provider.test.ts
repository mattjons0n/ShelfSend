import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverProviderClient } from "../../server/cover-providers.js";
import * as identifiers from "../../server/hardcover-search.js";
import { hardcoverDiscoverySeries } from "../../server/hardcover-provider.js";

const ASIN = "B09KS6PMGF";
const ISBN = "9798434681247";
const AUTHOR = "Nicholas Sansbury Smith";
const book = (id = 1098689, author = AUTHOR) => ({
  id, title: "Dark Moon", slug: "dark-moon-2022", release_year: 2022, image: null,
  contributions: [{ contribution: null, author: { name: author } }],
  book_series: [{ series_id: 88, position: 3, series: { name: "E-Day" } }],
  editions: [{ isbn_13: "9780140328721", asin: "B012345678" }],
});
const edition = (id = 1098689, isbn: string | null = ISBN, author = AUTHOR) => ({ asin: ASIN, isbn_10: null, isbn_13: isbn, book: book(id, author) });
type Request = { query: string; variables: Record<string, unknown> };
const response = (data: unknown) => new Response(JSON.stringify({ data }));

function fixture(options: {
  asin?: unknown[]; isbn?: unknown[]; error?: number;
  afterAsin?: () => void;
} = {}) {
  let now = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const requests: Request[] = [];
  const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    now += 1_000;
    const request = JSON.parse(String(init?.body)) as Request;
    requests.push(request);
    if (request.query.includes("ByAsin")) {
      options.afterAsin?.();
      return options.error ? new Response("private provider details", { status: options.error }) : response({ editions: options.asin ?? [edition()] });
    }
    if (request.query.includes("ByIsbn")) return response({ editions: options.isbn ?? [] });
    if (request.query.includes("SeriesSearch")) return response({ search: { ids: [1098689], error: null } });
    return response({ books: [book()] });
  });
  return { client: new CoverProviderClient(fetcher, undefined, 1_000, "private-token"), requests, fetcher };
}

afterEach(() => vi.restoreAllMocks());

describe("exact Hardcover ASIN lookup", () => {
  it.each([ASIN, `ASIN:${ASIN}`, `urn:asin:${ASIN.toLowerCase()}`])("finds the work and series without title parsing using %s", async (identifier) => {
    const { client, requests } = fixture();
    const result = await client.lookupHardcoverBook({ title: "Completely different local title", author: AUTHOR, identifier });
    expect(result.matchedBookId).toBe(1098689);
    expect(result.books[0]).toMatchObject({ id: 1098689, identifiers: [`ISBN:${ISBN}`, `ASIN:${ASIN}`], series: [{ id: 88, name: "E-Day", position: 3 }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ variables: { asin: ASIN, limit: 21 } });
    expect(requests[0]?.query).toContain("asin: {_eq: $asin}");
  });

  it.each([ISBN, null])("suggests only the exact ASIN edition's identifiers (ISBN %s)", async (isbn) => {
    const { client, requests } = fixture({ asin: [edition(1098689, isbn)] });
    const result = await client.searchMetadata("hardcover", { asin: ASIN, title: "Unrelated local title", author: AUTHOR }, 12);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ candidateId: "book-1098689-series-88", confidence: "high", metadata: { series: "E-Day", seriesIndex: 3 } });
    expect(result[0]?.metadata.identifiers).toEqual([...(isbn ? [`ISBN:${isbn}`] : []), `ASIN:${ASIN}`]);
    expect(JSON.stringify(result)).not.toContain("9780140328721");
    expect(requests).toHaveLength(1);
  });

  it("finds the Hardcover work even when the Kindle edition has no ISBN", async () => {
    const { client } = fixture({ asin: [edition(1098689, null)] });
    const result = await client.lookupHardcoverBook({ asin: ASIN });
    expect(result.matchedBookId).toBe(1098689);
    expect(result.books[0]?.identifiers).toEqual([`ASIN:${ASIN}`]);
  });

  it.each(["0123456789", "A012345678"])("preserves explicit ASIN field provenance for %s", async (asin) => {
    const { client, requests } = fixture({ asin: [{ ...edition(), asin }] });
    const result = await client.lookupHardcoverBook({ asin, author: AUTHOR });
    expect(result.matchedBookId).toBe(1098689);
    expect(result.books[0]?.identifiers).toContain(`ASIN:${asin}`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables.asin).toBe(asin);
  });

  it("extracts both identifier types without treating UUIDs or unrelated identifiers as ASINs", () => {
    expect(identifiers.hardcoverLookupIdentifiers(["urn:uuid:12345678-1234-1234-1234-123456789012", `urn:asin:${ASIN}`, `ISBN:${ISBN}`])).toEqual({ identifier: ISBN, asin: ASIN });
    for (const value of ["UUID:B09KS6PMGF", "urn:uuid:B09KS6PMGF", "9798434681247", "A012345678", "ASIN:B09K-S6PMGF", "B09KS6PMGFextra"])
      expect(identifiers.hardcoverAsin(value)).toBeNull();
  });

  it("falls back after an absent ASIN, keeping ISBN ahead of title search", async () => {
    const { client, requests } = fixture({ asin: [], isbn: [{ isbn_13: ISBN, book: book() }] });
    const result = await client.lookupHardcoverBook({ asin: ASIN, identifier: ISBN, author: AUTHOR });
    expect(result.matchedBookId).toBe(1098689);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("ByAsin");
    expect(requests[1]?.query).toContain("ByIsbn");
  });

  it("uses normal title fallback only when neither exact identifier is recorded", async () => {
    const { client, requests } = fixture({ asin: [] });
    const result = await client.lookupHardcoverBook({ asin: ASIN, title: "Dark Moon", author: AUTHOR });
    expect(result.matchedBookId).toBe(1098689);
    expect(requests.map((item) => item.query.includes("ByAsin") ? "asin" : item.query.includes("SeriesSearch") ? "search" : "details")).toEqual(["asin", "search", "details"]);
  });

  it.each(["discovery", "metadata"])("preserves conflicting ASIN/ISBN work identities as choices in %s", async (mode) => {
    const { client, requests } = fixture({ isbn: [{ isbn_13: ISBN, book: book(99) }] });
    const terms = { asin: ASIN, identifier: ISBN, title: "Dark Moon", author: AUTHOR };
    if (mode === "discovery") {
      const result = await client.lookupHardcoverBook(terms);
      expect(result.books.map((item) => item.id).sort()).toEqual([1098689, 99].sort());
      expect(result.matchedBookId).toBeNull();
    } else {
      const result = await client.searchMetadata("hardcover", terms, 12);
      expect(result).toHaveLength(2);
      expect(result.every((item) => item.confidence !== "high")).toBe(true);
    }
    expect(requests).toHaveLength(2);
    expect(requests.every((item) => !item.query.includes("SeriesSearch"))).toBe(true);
  });

  it("does not auto-select an exact ASIN with a conflicting author", async () => {
    const { client, requests } = fixture({ asin: [edition(1098689, ISBN, "Someone Else")] });
    const result = await client.lookupHardcoverBook({ asin: ASIN, title: "Dark Moon", author: AUTHOR });
    expect(result.books).toHaveLength(1);
    expect(result.matchedBookId).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it.each([2, 21])("deduplicates same-work ASIN editions but does not auto-select a truncated page (%s rows)", async (count) => {
    const { client } = fixture({ asin: Array.from({ length: count }, () => edition()) });
    const result = await client.lookupHardcoverBook({ asin: ASIN, author: AUTHOR });
    expect(result.books).toHaveLength(1);
    expect(result.matchedBookId).toBe(count > 20 ? null : 1098689);
  });

  it("keeps distinct work identities sharing one ASIN as choices", async () => {
    const { client } = fixture({ asin: [edition(), edition(99)] });
    const result = await client.lookupHardcoverBook({ asin: ASIN, author: AUTHOR });
    expect(result.books).toHaveLength(2);
    expect(result.matchedBookId).toBeNull();
  });

  it("selects one work after merging two complete identifier pages even when their combined edition count exceeds the display limit", async () => {
    const { client } = fixture({ asin: Array.from({ length: 20 }, () => edition()), isbn: [{ isbn_13: ISBN, book: book() }] });
    const result = await client.lookupHardcoverBook({ asin: ASIN, identifier: ISBN, author: AUTHOR });
    expect(result.books).toHaveLength(1);
    expect(result.matchedBookId).toBe(1098689);
  });

  it("does not hide a conflicting ISBN work behind duplicate ASIN editions in metadata choices", async () => {
    const { client } = fixture({ asin: Array.from({ length: 20 }, () => edition()), isbn: [{ isbn_13: ISBN, book: book(99) }] });
    const result = await client.searchMetadata("hardcover", { asin: ASIN, identifier: ISBN, author: AUTHOR }, 20);
    expect(result.map((item) => item.candidateId)).toEqual(["book-1098689-series-88", "book-99-series-88"]);
    expect(result.every((item) => item.confidence !== "high")).toBe(true);
  });

  it("retains typed ASINs on series roster entries for local ownership matching", () => {
    const page = hardcoverDiscoverySeries({ id: 88, name: "E-Day", book_series: [{ position: 3, book: { ...book(), editions: [edition()] } }] }, 88, 50, 0);
    expect(page?.books[0]?.identifiers).toContain(`ASIN:${ASIN}`);
  });

  it("resolves requested ASINs only within the displayed series works, retaining cross-work conflicts", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Request);
      return response({ editions: [
        { book_id: 1098689, asin: ASIN, isbn_13: ISBN, isbn_10: null },
        { book_id: 1098689, asin: ASIN, isbn_13: ISBN, isbn_10: null },
        { book_id: 99, asin: ASIN, isbn_13: null, isbn_10: null },
      ] });
    });
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    await expect(client.lookupHardcoverEditionIdentifiers([`ASIN:${ASIN}`, ASIN], [1098689, 99])).resolves.toEqual([
      { id: 1098689, identifiers: [`ISBN:${ISBN}`, `ASIN:${ASIN}`] },
      { id: 99, identifiers: [`ASIN:${ASIN}`] },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables).toEqual({ asins: [ASIN], bookIds: [1098689, 99], limit: 2001 });
    expect(requests[0]?.query).toContain("asin: {_in: $asins}");
    expect(requests[0]?.query).toContain("book_id: {_in: $bookIds}");
  });

  it.each(["truncated", "unrequested", "invalid-input"])("rejects %s edition ownership resolution rather than declaring books owned or missing", async (reason) => {
    const row = { book_id: reason === "unrequested" ? 999 : 1098689, asin: ASIN, isbn_13: ISBN };
    const fetcher = vi.fn(async () => response({ editions: reason === "truncated" ? Array.from({ length: 2001 }, () => row) : [row] }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    await expect(client.lookupHardcoverEditionIdentifiers(reason === "invalid-input" ? ["urn:uuid:1234"] : [ASIN], [1098689])).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(reason === "invalid-input" ? 0 : 1);
  });

  it("resolves a non-B ASIN from the explicit edition identity input field", async () => {
    const fetcher = vi.fn(async () => response({ editions: [{ book_id: 1098689, asin: "0123456789", isbn_13: null }] }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    await expect(client.lookupHardcoverEditionIdentifiers(["0123456789"], [1098689])).resolves.toEqual([{ id: 1098689, identifiers: ["ASIN:0123456789"] }]);
  });

  it.each([[429, "provider_rate_limited"], [503, "provider_unavailable"]])("keeps ASIN provider HTTP %s as an error instead of a title fallback", async (status, code) => {
    const { client, requests } = fixture({ error: status as number });
    await expect(client.lookupHardcoverBook({ asin: ASIN, title: "Dark Moon" })).rejects.toMatchObject({ code });
    expect(requests).toHaveLength(1);
  });

  it("honors cancellation before moving from ASIN to the ISBN request", async () => {
    const controller = new AbortController();
    const { client, requests } = fixture({ afterAsin: () => controller.abort() });
    await expect(client.lookupHardcoverBook({ asin: ASIN, identifier: ISBN }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  });
});
