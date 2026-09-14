// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initBoko, { book_info, convert } from "../../client/vendor/boko/boko.js";
import { prepareKindleSideload } from "../../client/src/api/azw3-sideload";
import { createEphemeralEpubDerivative } from "../../client/src/api/epub-overrides";
import { AppError } from "../../client/src/app-error";
import { epubFixture } from "./epub-fixture";

afterEach(() => vi.restoreAllMocks());

function collectionMetadata(count: number): string {
  return Array.from({ length: count }, (_, index) => `<meta property="belongs-to-collection" id="collection-${index}">Collection ${index}</meta>`).join("");
}

function plausiblePng(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

beforeAll(async () => {
  const wasm = await readFile(resolve("client/vendor/boko/boko_bg.wasm"));
  await initBoko(wasm);
});

describe("ephemeral EPUB metadata derivatives", () => {
  it("resolves a sparse series position with linear attribute work, even when no collection is typed", async () => {
    const originalGet = Element.prototype.getAttribute;
    const counts: number[] = [];
    let reads = 0;
    vi.spyOn(Element.prototype, "getAttribute").mockImplementation(function (this: Element, name) {
      reads += 1;
      return originalGet.call(this, name);
    });
    for (const count of [200, 400]) {
      reads = 0;
      const result = await createEphemeralEpubDerivative(epubFixture({}, collectionMetadata(count)), { seriesIndex: 2.5 });
      counts.push(reads);
      expect(reads).toBeLessThan(count * 8 + 100);
      const text = new TextDecoder().decode(result);
      expect(text).toContain('refines="#collection-0" property="group-position">2.5');
      expect(text).toContain(`Collection ${count - 1}`);
      expect(text).toContain("Original title");
    }
    expect(counts[1]).toBeLessThan(counts[0]! * 2.2);
  });

  it("preserves unrelated collection positions and sparse inherit/clear semantics", async () => {
    const metadata = `${collectionMetadata(3)}
      <meta property="collection-type" refines="#collection-2"> series </meta>
      <meta property="group-position" refines="#collection-0">7</meta>
      <meta property="group-position" refines="#collection-2">3</meta>`;
    const source = epubFixture({}, metadata);
    const updated = new TextDecoder().decode(await createEphemeralEpubDerivative(source, { seriesIndex: 4 }));
    expect(updated).toContain('refines="#collection-2" property="group-position">4');
    expect(updated).toContain('property="group-position" refines="#collection-0">7');
    expect(updated).not.toContain('property="group-position" refines="#collection-2">3');
    expect(updated).toContain('id="collection-2">Collection 2');
    const cleared = new TextDecoder().decode(await createEphemeralEpubDerivative(source, { seriesIndex: null }));
    expect(cleared).toContain('property="group-position" refines="#collection-0">7');
    expect(cleared).not.toMatch(/(?:property="group-position" refines="#collection-2"|refines="#collection-2" property="group-position")/u);
    const inherited = new TextDecoder().decode(await createEphemeralEpubDerivative(source, { title: "New title" }));
    expect(inherited).toContain('property="group-position" refines="#collection-2">3');
    await expect(createEphemeralEpubDerivative(epubFixture(), { seriesIndex: null })).resolves.toBeInstanceOf(Uint8Array);
    await expect(createEphemeralEpubDerivative(epubFixture(), { seriesIndex: 1 })).rejects.toMatchObject({ code: "CONVERSION_INVALID_INPUT" });
  });

  it("lets an actual cancellation task interrupt the metadata scan before serialization", async () => {
    const source = epubFixture({}, collectionMetadata(1000));
    const original = source.slice();
    const abort = new AbortController();
    const get = Element.prototype.getAttribute;
    let collectionsVisited = 0;
    vi.spyOn(Element.prototype, "getAttribute").mockImplementation(function (this: Element, name) {
      const value = get.call(this, name);
      if (name === "property" && value === "belongs-to-collection") {
        collectionsVisited += 1;
        if (collectionsVisited === 20) globalThis.setTimeout(() => abort.abort(), 0);
      }
      return value;
    });
    const serialize = vi.spyOn(XMLSerializer.prototype, "serializeToString");
    await expect(createEphemeralEpubDerivative(source, { seriesIndex: 2 }, () => {
      if (abort.signal.aborted) throw new AppError("CONVERSION_ABORTED", "Cancelled");
    })).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    expect(collectionsVisited).toBeGreaterThanOrEqual(20);
    expect(collectionsVisited).toBeLessThan(150);
    expect(serialize).not.toHaveBeenCalled();
    expect(source).toEqual(original);
  });

  it("embeds edited metadata and a cover for boko without mutating the source", async () => {
    const source = new Uint8Array(await readFile(resolve("tests/fixtures/epictetus.epub")));
    const original = source.slice();

    const replacementCover = plausiblePng(1_400, 2_100);
    const derivative = await createEphemeralEpubDerivative(source, {
      title: "The Edited Discourses",
      titleSort: "Edited Discourses, The",
      authors: ["A New Author", "Second Author"],
      authorSort: "New Author, A",
      language: "sv",
      publisher: "Kindle Bridge Press",
      publishedAt: "2026-09-01",
      series: "Household Classics",
      seriesIndex: 2.5,
      subjects: ["Philosophy", "Edited locally"],
      identifiers: ["isbn:9780000000002"],
      description: "A deliberately edited catalog description.",
      cover: { bytes: replacementCover, mediaType: "image/png" },
    });

    expect(source).toEqual(original);
    expect(derivative).not.toEqual(source);
    const metadata = JSON.parse(String(book_info(derivative, "epub"))) as {
      title: string;
      authors: string[];
      language: string;
    };
    expect(metadata).toMatchObject({
      title: "The Edited Discourses",
      authors: ["A New Author", "Second Author"],
      language: "sv",
    });

    const derivativeNames = new TextDecoder("windows-1252").decode(derivative);
    expect(derivativeNames).toContain("epub/images/cover.jpg");
    expect(derivativeNames).not.toContain("kindle-bridge-cover");
    expect(includesBytes(derivative, replacementCover)).toBe(true);

    const prepared = prepareKindleSideload(convert(derivative, "epub", "azw3"));
    expect(prepared.metadata).toEqual({ documentType: "PDOC", embeddedCover: true });
    expect(includesBytes(prepared.bytes, replacementCover)).toBe(true);
    const artifactText = new TextDecoder("windows-1252").decode(prepared.bytes);
    expect(artifactText).toContain("The Edited Discourses");
    expect(artifactText).toContain("Kindle Bridge Press");
  });
});
