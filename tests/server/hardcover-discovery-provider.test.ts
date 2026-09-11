import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverProviderClient } from "../../server/cover-providers.js";
import { hardcoverBookUrl, hardcoverCoverUrl, hardcoverDiscoveryLookup, hardcoverDiscoverySeries } from "../../server/hardcover-provider.js";

const ISBN = "9780140328721";
const book = (id = 12, overrides: Record<string, unknown> = {}) => ({
  id,
  title: "Example Book",
  slug: "example-book-42",
  image: { url: "https://assets.hardcover.app/edition/123/cover.jpg" },
  release_year: 2025,
  contributions: [{ contribution: null, author: { name: "Example Author" } }, { contribution: "Narrator", author: { name: "Not the author" } }],
  book_series: [{ series_id: 50, position: 1.5, series: { name: "The Example Cycle" } }],
  editions: [{ isbn_13: ISBN }],
  ...overrides,
});
const dataResponse = (data: unknown, headers?: Record<string, string>) => new Response(JSON.stringify({ data }), { headers });
const requestBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
const series = (rows: unknown[]) => ({ id: 50, name: "The Example Cycle", book_series: rows });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Hardcover read-only book discovery", () => {
  it("resolves the ISBN first, keeps standalone books, and returns only bounded public metadata", async () => {
    const fetcher = vi.fn(async () => dataResponse({ editions: [{ isbn_13: ISBN, book: book(12, { book_series: [] }) }] }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "saved-secret");
    await expect(client.lookupHardcoverBook({ identifier: "ISBN:978-0-14-032872-1", title: "Local title" })).resolves.toEqual({
      matchedBookId: 12,
      books: [{ id: 12, title: "Example Book", authors: ["Example Author"], identifiers: [`ISBN:${ISBN}`], series: [], url: "https://hardcover.app/books/example-book-42", coverUrl: "https://assets.hardcover.app/edition/123/cover.jpg", releaseYear: 2025 }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://api.hardcover.app/v1/graphql");
    expect(requestBody(init)).toMatchObject({ variables: { isbn: ISBN, limit: 21 } });
    expect(requestBody(init).query).toContain("slug release_year image { url }");
    expect(requestBody(init).query).toContain("isbn_13: {_eq: $isbn}");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer saved-secret");
  });

  it("falls back to title and author, uses typed search IDs, and preserves relevance order", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const requests: ReturnType<typeof requestBody>[] = [];
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      now += 1_000;
      const body = requestBody(init);
      requests.push(body);
      if (body.query.includes("BookByIsbn")) return dataResponse({ editions: [] });
      if (body.query.includes("SeriesSearch")) return dataResponse({ search: { ids: [42, 12, 42, -1, "invalid"], error: null } });
      return dataResponse({ books: [book(12, { title: "Different Book", editions: [] }), book(42, { editions: [] }), book(999)] });
    });
    const result = await new CoverProviderClient(fetcher, undefined, 1_000, "secret").lookupHardcoverBook({ title: " Example  Book ", author: "Example Author", identifier: ISBN });
    expect(result.books.map((item) => item.id)).toEqual([42, 12]);
    expect(result.matchedBookId).toBe(42);
    expect(requests[1]?.variables).toEqual({ query: "Example Book Example Author", limit: 21 });
    expect(requests[2]?.variables).toEqual({ ids: [42, 12], limit: 21 });
    expect(requests.every((request) => !request.query.includes("mutation") && !request.query.includes("_ilike"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("deduplicates ISBN editions by book identity but leaves multiple exact books as review choices", () => {
    const rows = [{ isbn_13: ISBN, book: book() }, { isbn_10: "0140328726", book: book() }];
    expect(hardcoverDiscoveryLookup(rows, { identifier: ISBN }, 20, true)).toMatchObject({ books: [{ id: 12, identifiers: [`ISBN:${ISBN}`, "ISBN:0140328726"] }], matchedBookId: 12 });
    const ambiguous = hardcoverDiscoveryLookup([...rows, { isbn_13: ISBN, book: book(13) }], { identifier: ISBN }, 20, true);
    expect(ambiguous?.books).toHaveLength(2);
    expect(ambiguous?.matchedBookId).toBeNull();
  });

  it("requires exact normalized title and author, and never automatically picks ambiguous or truncated choices", () => {
    expect(hardcoverDiscoveryLookup([book()], { title: "example book", author: "EXAMPLE AUTHOR" }, 20)?.matchedBookId).toBe(12);
    expect(hardcoverDiscoveryLookup([book()], { title: "Example Book" }, 20)?.matchedBookId).toBeNull();
    expect(hardcoverDiscoveryLookup([book()], { title: "Example Book", author: "Different Author" }, 20)?.matchedBookId).toBeNull();
    expect(hardcoverDiscoveryLookup([book(), book(13)], { title: "Example Book", author: "Example Author" }, 20)?.matchedBookId).toBeNull();
    expect(hardcoverDiscoveryLookup([book()], { identifier: ISBN }, 20, false, true)?.matchedBookId).toBeNull();
    const result = hardcoverDiscoveryLookup(Array.from({ length: 21 }, (_, index) => book(index + 1)), { identifier: ISBN }, 20);
    expect(result?.books).toHaveLength(20);
    expect(result?.matchedBookId).toBeNull();
  });

  it.each([
    { editions: "bad" },
    { editions: [{ isbn_13: ISBN, book: null }] },
    { editions: [{ isbn_13: ISBN, book: book(12, { title: "" }) }] },
    { editions: [{ isbn_13: ISBN, book: book(12, { book_series: "bad" }) }] },
  ])("rejects malformed ISBN data without reporting a successful empty lookup", async (response) => {
    const client = new CoverProviderClient(async () => dataResponse(response), undefined, 1_000, "token");
    await expect(client.lookupHardcoverBook({ identifier: ISBN })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("reports empty searches and absent credentials through the existing provider boundary", async () => {
    const fetcher = vi.fn(async () => dataResponse({ search: { ids: [], error: null } }));
    await expect(new CoverProviderClient(fetcher).lookupHardcoverBook({ title: "Example" })).rejects.toMatchObject({ code: "provider_not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new CoverProviderClient(fetcher, undefined, 1_000, "token").lookupHardcoverBook({ title: "Example" })).resolves.toEqual({ books: [], matchedBookId: null });
  });
});

describe("Hardcover book and image URLs", () => {
  it("uses the API slug or the documented ID route without inventing a title slug", () => {
    expect(hardcoverBookUrl("a-real-slug-123", 12)).toBe("https://hardcover.app/books/a-real-slug-123");
    expect(hardcoverBookUrl("blå-bok", 12)).toBe("https://hardcover.app/books/bl%C3%A5-bok");
    for (const slug of [undefined, null, "", "a title with spaces", "../settings", "%2fsecret", "https://attacker.test/", "//attacker.test", "book?token=secret", "book#fragment", "a".repeat(501)]) {
      expect(hardcoverBookUrl(slug, 12)).toBe("https://hardcover.app/id/book/12");
    }
    expect(hardcoverBookUrl(null, -1)).toBeNull();
  });

  it("allows only bounded HTTPS images from the confirmed Hardcover CDN", () => {
    const asset = "https://assets.hardcover.app/edition/123/cover.jpg";
    expect(hardcoverCoverUrl(asset)).toBe(asset);
    const transformed = `https://production-img.hardcover.app/crop?width=300&url=${encodeURIComponent(asset)}`;
    expect(hardcoverCoverUrl(transformed)).toBe(transformed);
    for (const url of ["http://assets.hardcover.app/cover.jpg", "https://assets.hardcover.app.attacker.test/cover.jpg", "https://attacker.test/cover.jpg", "https://assets.hardcover.app:444/cover.jpg", "https://name:secret@assets.hardcover.app/cover.jpg", "https://assets.hardcover.app/cover.jpg#secret", "https://assets.hardcover.app/cover\n.jpg", "https://assets.hardcover.app/" + "x".repeat(2_048), "data:image/png;base64,AAA", "https://production-img.hardcover.app/crop?url=https%3A%2F%2Fattacker.test%2Fcover.jpg"]) {
      expect(hardcoverCoverUrl(url)).toBeNull();
    }
  });
});

describe("Hardcover complete series pagination", () => {
  it("requests numeric ordering before paging and uses a sentinel for truthful hasMore", async () => {
    const fetcher = vi.fn(async () => dataResponse({ series_by_pk: series([
      { position: 0, book: book(1) }, { position: 1.5, book: book(2) }, { position: 2, book: book(3) },
    ]) }));
    const result = await new CoverProviderClient(fetcher, undefined, 1_000, "token").getHardcoverSeries(50, 2, 0);
    expect(result).toMatchObject({ id: 50, name: "The Example Cycle", offset: 0, limit: 2, hasMore: true });
    expect(result.books.map((item) => item.position)).toEqual([0, 1.5]);
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(requestBody(init).variables).toEqual({ seriesId: 50, limit: 3, offset: 0 });
    expect(requestBody(init).query).toContain("order_by: [{position: asc_nulls_last}, {id: asc}]");
    expect(requestBody(init).query).not.toContain("distinct_on: position");
    expect(requestBody(init).query).not.toContain("compilation:");
  });

  it("keeps zero, fractions, null positions, and different books at a shared position; exact duplicate memberships collapse", () => {
    const result = hardcoverDiscoverySeries(series([
      { position: null, book: book(6) },
      { position: 2, book: book(4) },
      { position: 1.5, book: book(3) },
      { position: 0, book: book(1) },
      { position: 1.5, book: book(2) },
      { position: 1.5, book: book(2) },
      { position: 2, book: book(2) },
    ]), 50, 50, 0);
    expect(result?.books.map((item) => [item.id, item.position])).toEqual([[1, 0], [3, 1.5], [2, 1.5], [4, 2], [2, 2], [6, null]]);
    expect(result?.hasMore).toBe(false);
  });

  it("reports hasMore from raw memberships even if duplicates make the page sparse", () => {
    const result = hardcoverDiscoverySeries(series([
      { position: 1, book: book(1) }, { position: 1, book: book(1) }, { position: 2, book: book(2) },
    ]), 50, 2, 50);
    expect(result).toMatchObject({ offset: 50, limit: 2, hasMore: true });
    expect(result?.books).toHaveLength(1);
    expect(hardcoverDiscoverySeries(series([]), 50, 50, 100)).toMatchObject({ books: [], hasMore: false, offset: 100 });
  });

  it.each([null, { id: 51, name: "Wrong series", book_series: [] }, { id: 50, name: "", book_series: [] }, series([{ position: 1, book: null }]), series([{ position: 1, book: book(1, { editions: "wrong" }) }]), { id: 50, name: "Series", book_series: null }])("rejects missing or malformed series rather than claiming completeness", async (response) => {
    const client = new CoverProviderClient(async () => dataResponse({ series_by_pk: response }), undefined, 1_000, "token");
    await expect(client.getHardcoverSeries(50)).rejects.toMatchObject({ code: response === null ? "invalid_candidate" : "provider_unavailable" });
  });

  it("rejects out-of-bounds input before making requests", async () => {
    const fetcher = vi.fn();
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    for (const [id, limit, offset] of [[0, 50, 0], [2_147_483_648, 50, 0], [50, 0, 0], [50, 51, 0], [50, 1.5, 0], [50, 50, -1], [50, 50, 10_001], [50, 50, NaN]]) {
      await expect(client.getHardcoverSeries(id!, limit!, offset!)).rejects.toMatchObject({ code: "invalid_candidate" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shares provider cooldown with existing metadata lookups", async () => {
    const fetcher = vi.fn(async () => new Response("limited", { status: 429, headers: { "Retry-After": "120" } }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "secret");
    await expect(client.getHardcoverSeries(50)).rejects.toMatchObject({ code: "provider_rate_limited" });
    await expect(client.lookupHardcoverBook({ identifier: ISBN })).rejects.toMatchObject({ code: "provider_rate_limited" });
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 12)).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a queued discovery call without sending its provider request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => dataResponse({ series_by_pk: series([]) }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    const first = client.getHardcoverSeries(50);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const controller = new AbortController();
    const second = client.getHardcoverSeries(50, 50, 50, controller.signal);
    const rejection = expect(second).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
