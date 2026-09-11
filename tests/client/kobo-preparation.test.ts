// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { prepareKoboArtifact } from "../../client/src/kobo/prepare";
import { MAX_BOOK_SOURCE_BYTES } from "../../client/src/book-limits";

const encoder = new TextEncoder();

function zip(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = typeof value === "string" ? encoder.encode(value) : value;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint32(14, crc32(data), true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc32(data), true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const result = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...locals, ...centrals]) { result.set(part, cursor); cursor += part.length; }
  const end = new DataView(result.buffer, cursor);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, locals.length, true);
  end.setUint16(10, locals.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return result;
}

function epub(extra: Readonly<Record<string, string | Uint8Array>> = {}): Uint8Array {
  return zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/book.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:original-book</dc:identifier><dc:title>Original title</dc:title><dc:creator>Original Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="font" href="font.ttf" media-type="font/ttf"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    "OPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>Original text</p></body></html>',
    "OPS/font.ttf": new Uint8Array([1, 2, 3, 4]),
    ...extra,
  });
}

function fixture(bytes = epub()) {
  const source = new Blob([Uint8Array.from(bytes)], { type: "application/epub+zip" });
  const book = { id: "book-1", title: "Original title", format: "EPUB", size: source.size, contentHash: createHash("sha256").update(bytes).digest("hex") };
  return { bytes, source, book };
}

function encryption(algorithm: string, target = "OPS/font.ttf"): string {
  return `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${algorithm}"/><CipherData><CipherReference URI="${target}"/></CipherData></EncryptedData></encryption>`;
}

describe("Kobo EPUB preparation", () => {
  it("validates then sends an unchanged EPUB without invoking conversion or changing its bytes", async () => {
    const { source, bytes, book } = fixture();
    const phases: string[] = [];
    const result = await prepareKoboArtifact(book, source, { onPhase: (phase) => phases.push(phase) });
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
    expect(result).toMatchObject({ filename: "Original title.epub", sourceHash: book.contentHash, artifactHash: book.contentHash, overridesApplied: false });
    expect(result.blob.type).toBe("application/epub+zip");
    expect(phases).toEqual(["preparing", "validating", "ready"]);
  });

  it("validates a real deflated EPUB without loading boko", async () => {
    const { source, book } = fixture(new Uint8Array(await readFile("tests/fixtures/epictetus.epub")));
    const result = await prepareKoboArtifact(book, source, {});
    expect(result.artifactHash).toBe(book.contentHash);
  });

  it("applies reviewed title, series and cover only to the derived EPUB", async () => {
    const { source, bytes, book } = fixture();
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const result = await prepareKoboArtifact(book, source, { overrides: {
      title: "Edited title", authors: ["Reviewed Author"], series: "Reviewed series", seriesIndex: 1.5,
      cover: { blob: new Blob([cover]), mediaType: "image/jpeg" },
    } });
    const derivative = new TextDecoder().decode(await result.blob.arrayBuffer());
    expect(derivative).toContain("Edited title");
    expect(derivative).toContain("Reviewed Author");
    expect(derivative).toContain("Reviewed series");
    expect(derivative).toContain('property="group-position">1.5');
    expect(derivative).toContain('properties="cover-image"');
    expect(result.overridesApplied).toBe(true);
    expect(result.artifactHash).not.toBe(book.contentHash);
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(bytes);
  });

  it("rejects AZW3 before reading or preparing anything", async () => {
    const { source, book } = fixture();
    const read = vi.spyOn(source, "arrayBuffer");
    await expect(prepareKoboArtifact({ ...book, format: "AZW3" }, source, {})).rejects.toMatchObject({ message: expect.stringMatching(/Kobo.*EPUB/u) });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects missing hashes, changed size and changed source bytes", async () => {
    const { source, book } = fixture();
    await expect(prepareKoboArtifact({ ...book, contentHash: undefined }, source, {})).rejects.toMatchObject({ code: "CATALOG_HASH_MISSING" });
    await expect(prepareKoboArtifact({ ...book, contentHash: "0".repeat(64) }, source, {})).rejects.toMatchObject({ code: "CATALOG_SOURCE_CHANGED" });
    await expect(prepareKoboArtifact({ ...book, size: book.size + 1 }, source, {})).rejects.toMatchObject({ code: "CATALOG_SOURCE_CHANGED" });
  });

  it("enforces the 200 MiB boundary before reading the source", async () => {
    const { source, book } = fixture();
    Object.defineProperty(source, "size", { value: MAX_BOOK_SOURCE_BYTES + 1 });
    const read = vi.spyOn(source, "arrayBuffer");
    await expect(prepareKoboArtifact({ ...book, size: source.size }, source, {})).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects ordinary ZIPs, missing spine resources and malformed EPUB XML", async () => {
    for (const bytes of [zip({ other: "not an EPUB" }), epub({ "OPS/book.opf": '<package><metadata/></package>' }), epub({ "META-INF/container.xml": '<container><rootfiles></container>' })]) {
      const { source, book } = fixture(bytes);
      await expect(prepareKoboArtifact(book, source, {})).rejects.toMatchObject({ code: "CONVERSION_INVALID_INPUT" });
    }
  });

  it("rejects content DRM and font-obfuscation declarations pointing at content", async () => {
    for (const xml of [encryption("http://www.w3.org/2001/04/xmlenc#aes128-cbc", "OPS/chapter.xhtml"), encryption("http://www.idpf.org/2008/embedding", "OPS/chapter.xhtml"), "<encryption/>"]) {
      const { source, book } = fixture(epub({ "META-INF/encryption.xml": xml }));
      await expect(prepareKoboArtifact(book, source, {})).rejects.toMatchObject({ message: expect.stringMatching(/DRM|encryption/iu) });
    }
  });

  it("preserves supported font obfuscation but does not rewrite its identity key", async () => {
    const { source, book } = fixture(epub({ "META-INF/encryption.xml": encryption("http://www.idpf.org/2008/embedding") }));
    const result = await prepareKoboArtifact(book, source, { overrides: { title: "Reviewed title" } });
    expect(result.overridesApplied).toBe(true);
    await expect(prepareKoboArtifact(book, source, { overrides: { identifiers: ["ISBN:9781234567897"] } })).rejects.toMatchObject({ message: expect.stringMatching(/font.*identifier|identifier.*font/iu) });
  });

  it("rejects encrypted ZIP members even without encryption.xml", async () => {
    const bytes = epub();
    const end = new DataView(bytes.buffer, bytes.length - 22);
    const centralStart = end.getUint32(16, true);
    new DataView(bytes.buffer).setUint16(centralStart + 8, 1, true);
    const { source, book } = fixture(bytes);
    await expect(prepareKoboArtifact(book, source, {})).rejects.toMatchObject({ message: expect.stringMatching(/encrypted|DRM/iu) });
  });

  it("rejects forged ZIP expansion declarations before decompressing", async () => {
    const bytes = epub();
    const end = new DataView(bytes.buffer, bytes.length - 22);
    new DataView(bytes.buffer).setUint32(end.getUint32(16, true) + 24, 129 * 1024 * 1024, true);
    const { source, book } = fixture(bytes);
    await expect(prepareKoboArtifact(book, source, {})).rejects.toMatchObject({ code: "CONVERSION_INVALID_INPUT" });
  });

  it("honors cancellation before reading and after the source has been read", async () => {
    const { source, book } = fixture();
    const aborted = AbortSignal.abort();
    const read = vi.spyOn(source, "arrayBuffer");
    await expect(prepareKoboArtifact(book, source, { signal: aborted })).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    const controller = new AbortController();
    const originalRead = source.arrayBuffer.bind(source);
    vi.spyOn(source, "arrayBuffer").mockImplementation(async () => { const bytes = await originalRead(); controller.abort(); return bytes; });
    await expect(prepareKoboArtifact(book, source, { signal: controller.signal })).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
  });

  it("aborts a stalled source read and bounds preparation time", async () => {
    const { source, book } = fixture();
    vi.spyOn(source, "arrayBuffer").mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const aborted = prepareKoboArtifact(book, source, { signal: controller.signal });
    const assertion = expect(aborted).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    controller.abort();
    await assertion;
    vi.useFakeTimers();
    try {
      const timedOut = prepareKoboArtifact(book, source, {});
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: "CONVERSION_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(120_000);
      await timeoutAssertion;
    } finally { vi.useRealTimers(); }
  });
});
