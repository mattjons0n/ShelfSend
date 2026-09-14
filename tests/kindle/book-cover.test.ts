import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import initBoko, { convert } from "../../client/vendor/boko/boko.js";
import { extractKindleBookCover, inspectKindleCoverImage } from "../../client/src/kindle/book-cover";

const RECORD_ZERO = 112;
const MOBI_LENGTH = 132;
const EXTH = RECORD_ZERO + 16 + MOBI_LENGTH;

describe("read-only Kindle embedded cover extraction", () => {
  it("extracts the actual embedded cover from a real EPUB converted by boko", async () => {
    await initBoko(await readFile(fileURLToPath(new URL("../../client/vendor/boko/boko_bg.wasm", import.meta.url))));
    const epub = await readFile(fileURLToPath(new URL("../fixtures/epictetus.epub", import.meta.url)));
    const book = convert(epub, "epub", "azw3");
    const before = book.slice();
    const cover = extractKindleBookCover(book);

    expect(cover?.mediaType).toBe("image/jpeg");
    expect(cover?.bytes.byteLength).toBeGreaterThan(1_000);
    expect(book).toEqual(before);
  });

  it.each([
    ["image/jpeg", jpeg(600, 800)],
    ["image/png", png(600, 800)],
    ["image/gif", gif(600, 800)],
    ["image/webp", webp(600, 800)],
  ] as const)("returns %s bytes without editing or retaining the source buffer", (mediaType, image) => {
    const original = bookWithImages([image, png(100, 150)]);
    const buffer = new Uint8Array(original.length + 12);
    buffer.set(original, 5);
    const book = buffer.subarray(5, 5 + original.length);
    const before = buffer.slice();
    const cover = extractKindleBookCover(book);

    expect(cover).toEqual({ bytes: image, mediaType });
    expect(cover?.bytes.buffer).not.toBe(book.buffer);
    expect(cover?.bytes.buffer.byteLength).toBe(image.length);
    if (cover) cover.bytes[0] = 0;
    expect(buffer).toEqual(before);
  });

  it("prefers the cover and falls back to the thumbnail when it is absent, invalid, or out of range", () => {
    const thumbnail = png(100, 150);
    const fallback = { bytes: thumbnail, mediaType: "image/png" };
    expect(extractKindleBookCover(bookWithImages([jpeg(600, 800), thumbnail]))?.mediaType).toBe("image/jpeg");
    expect(extractKindleBookCover(bookWithImages([jpeg(600, 800), thumbnail], [{ type: 202, offset: 1 }]))).toEqual(fallback);
    expect(extractKindleBookCover(bookWithImages([new Uint8Array(24), thumbnail]))).toEqual(fallback);
    expect(extractKindleBookCover(bookWithImages([jpeg(600, 800), thumbnail], [
      { type: 201, offset: 999 }, { type: 202, offset: 1 },
    ]))).toEqual(fallback);
  });

  it("returns no cover for missing pointers, unsupported formats, encrypted books, or absent images", () => {
    expect(extractKindleBookCover(bookWithImages([jpeg(600, 800)], []))).toBeUndefined();
    expect(extractKindleBookCover(new TextEncoder().encode("<svg><script>bad</script></svg>"))).toBeUndefined();
    expect(extractKindleBookCover(bookWithImages([new TextEncoder().encode("<svg width='600' height='800'/>")]))).toBeUndefined();
    for (const encryption of [1, 2, 65_535]) {
      const book = bookWithImages([jpeg(600, 800)]);
      new DataView(book.buffer).setUint16(RECORD_ZERO + 12, encryption, false);
      expect(extractKindleBookCover(book)).toBeUndefined();
    }
    const noImages = bookWithImages([jpeg(600, 800)]);
    new DataView(noImages.buffer).setUint32(RECORD_ZERO + 0x6c, 0xffff_ffff, false);
    expect(extractKindleBookCover(noImages)).toBeUndefined();
  });

  it("rejects truncated or inconsistent PalmDB, MOBI, and EXTH bounds without throwing", () => {
    const source = bookWithImages([jpeg(600, 800)]);
    for (const length of [0, 60, 77, 85, 100, RECORD_ZERO + 20, EXTH + 11]) {
      expect(extractKindleBookCover(source.subarray(0, length))).toBeUndefined();
    }
    const mutations: Array<(book: Uint8Array, view: DataView) => void> = [
      (book) => { book[60] = 0; },
      (_book, view) => { view.setUint16(76, 0, false); },
      (_book, view) => { view.setUint16(76, 65_535, false); },
      (_book, view) => { view.setUint32(78, 80, false); },
      (_book, view) => { view.setUint32(86, RECORD_ZERO, false); },
      (_book, view) => { view.setUint32(94, 0xffff_ffff, false); },
      (book) => { book[RECORD_ZERO + 16] = 0; },
      (_book, view) => { view.setUint32(RECORD_ZERO + 20, 8, false); },
      (_book, view) => { view.setUint32(RECORD_ZERO + 20, 0xffff_ffff, false); },
      (book) => { book[EXTH] = 0; },
      (_book, view) => { view.setUint32(EXTH + 4, 11, false); },
      (_book, view) => { view.setUint32(EXTH + 4, 0xffff_ffff, false); },
      (_book, view) => { view.setUint32(EXTH + 8, 10_001, false); },
      (_book, view) => { view.setUint32(EXTH + 16, 7, false); },
      (_book, view) => { view.setUint32(EXTH + 16, 0xffff_ffff, false); },
    ];
    for (const mutate of mutations) {
      const book = source.slice();
      mutate(book, new DataView(book.buffer));
      expect(extractKindleBookCover(book)).toBeUndefined();
    }
  });

  it("bounds image records, dimensions, pixels, and the entire input", () => {
    const oversizedImage = new Uint8Array(12 * 1024 * 1024 + 1);
    oversizedImage.set(png(600, 800));
    expect(extractKindleBookCover(bookWithImages([oversizedImage]))).toBeUndefined();
    for (const image of [png(0, 800), png(8_193, 1), png(8_000, 8_000), jpeg(8_193, 1), gif(1, 8_193), webp(8_000, 8_000)]) {
      expect(extractKindleBookCover(bookWithImages([image]))).toBeUndefined();
    }
    const oversizedBook = new Uint8Array(200 * 1024 * 1024 + 1);
    // Keep the first cover record small, so only the whole-book limit rejects it.
    oversizedBook.set(bookWithImages([png(100, 150), new Uint8Array(10)]));
    expect(extractKindleBookCover(oversizedBook)).toBeUndefined();
  });

  it("validates cached raster bytes and both simple WebP encodings without trusting a stored MIME", () => {
    expect(inspectKindleCoverImage(new TextEncoder().encode("<svg width='600' height='800'/>"))).toBeUndefined();
    const lossy = webp(600, 800);
    ascii(lossy, 12, "VP8 ");
    lossy.set([0x9d, 0x01, 0x2a], 23);
    const lossyView = new DataView(lossy.buffer);
    lossyView.setUint16(26, 600, true);
    lossyView.setUint16(28, 800, true);
    expect(inspectKindleCoverImage(lossy)).toBe("image/webp");
    lossyView.setUint16(26, 8_193, true);
    expect(inspectKindleCoverImage(lossy)).toBeUndefined();

    const lossless = webp(600, 800);
    ascii(lossless, 12, "VP8L");
    lossless[20] = 0x2f;
    const losslessView = new DataView(lossless.buffer);
    losslessView.setUint32(21, (600 - 1) | ((800 - 1) << 14), true);
    expect(inspectKindleCoverImage(lossless)).toBe("image/webp");
    losslessView.setUint32(21, (8_000 - 1) | ((8_000 - 1) << 14), true);
    expect(inspectKindleCoverImage(lossless)).toBeUndefined();
  });

  it("rejects malformed JPEG segments and truncated WebP chunks", () => {
    const brokenJpeg = jpeg(600, 800);
    new DataView(brokenJpeg.buffer).setUint16(4, 0xffff, false);
    expect(extractKindleBookCover(bookWithImages([brokenJpeg]))).toBeUndefined();
    const brokenWebp = webp(600, 800);
    new DataView(brokenWebp.buffer).setUint32(16, 0xffff_ffff, true);
    expect(extractKindleBookCover(bookWithImages([brokenWebp]))).toBeUndefined();
    expect(extractKindleBookCover(bookWithImages([webp(600, 800).subarray(0, 25)]))).toBeUndefined();
  });
});

function bookWithImages(
  images: readonly Uint8Array[],
  pointers: readonly { type: number; offset: number }[] = [{ type: 201, offset: 0 }, { type: 202, offset: 1 }],
): Uint8Array {
  const text = new TextEncoder().encode("<html><body>Device book</body></html>");
  const exthLength = 12 + pointers.length * 12;
  const offsets = [RECORD_ZERO, EXTH + exthLength];
  let length = offsets[1]! + text.length;
  for (const image of images) {
    offsets.push(length);
    length += image.length;
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 60, "BOOKMOBI");
  view.setUint16(76, offsets.length, false);
  offsets.forEach((offset, index) => view.setUint32(78 + index * 8, offset, false));
  ascii(bytes, RECORD_ZERO + 16, "MOBI");
  view.setUint32(RECORD_ZERO + 20, MOBI_LENGTH, false);
  view.setUint32(RECORD_ZERO + 0x6c, 2, false);
  ascii(bytes, EXTH, "EXTH");
  view.setUint32(EXTH + 4, exthLength, false);
  view.setUint32(EXTH + 8, pointers.length, false);
  pointers.forEach((pointer, index) => {
    const offset = EXTH + 12 + index * 12;
    view.setUint32(offset, pointer.type, false);
    view.setUint32(offset + 4, 12, false);
    view.setUint32(offset + 8, pointer.offset, false);
  });
  bytes.set(text, offsets[1]);
  images.forEach((image, index) => bytes.set(image, offsets[index + 2]));
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(23);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xc0]);
  view.setUint16(4, 17, false);
  bytes[6] = 8;
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  bytes.set([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9], 11);
  return bytes;
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13, false);
  ascii(bytes, 12, "IHDR");
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  ascii(bytes, 0, "GIF89a");
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(bytes, 8, "WEBPVP8X");
  view.setUint32(16, 10, true);
  view.setUint32(24, width - 1, true);
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >>> 8) & 0xff;
  bytes[29] = ((height - 1) >>> 16) & 0xff;
  return bytes;
}

function ascii(bytes: Uint8Array, offset: number, text: string): void {
  bytes.set(new TextEncoder().encode(text), offset);
}
