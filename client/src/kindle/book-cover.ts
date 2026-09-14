export interface KindleBookCover {
  /** An owned copy of the image record, never a view retaining the book file. */
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

const MAX_BOOK_BYTES = 200 * 1024 * 1024;
const MAX_COVER_BYTES = 12 * 1024 * 1024;
const MAX_DIMENSION = 8_192;
const MAX_PIXELS = 40_000_000;
const MAX_EXTH_RECORDS = 10_000;
const RECORD_TABLE_START = 78;
const RECORD_ENTRY_BYTES = 8;
const PALMDOC_HEADER_BYTES = 16;
const FIRST_IMAGE_RECORD_OFFSET = 0x6c;

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function boundedDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0
    && width <= MAX_DIMENSION && height <= MAX_DIMENSION
    && height <= Math.floor(MAX_PIXELS / width);
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number)
    | ((bytes[offset + 1] as number) << 8)
    | ((bytes[offset + 2] as number) << 16);
}

/** Bounded raster header inspection for device covers and their local cache.
 * This does not decode pixels; the browser may still reject an invalid image.
 * SVG and other active or unrecognized formats are never accepted.
 */
export function inspectKindleCoverImage(bytes: Uint8Array): KindleBookCover["mediaType"] | undefined {
  if (bytes.byteLength < 10 || bytes.byteLength > MAX_COVER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 33
    && bytes[0] === 0x89 && hasAscii(bytes, 1, "PNG")
    && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
    && view.getUint32(8, false) === 13 && hasAscii(bytes, 12, "IHDR")) {
    return boundedDimensions(view.getUint32(16, false), view.getUint32(20, false)) ? "image/png" : undefined;
  }
  if (bytes.byteLength >= 13 && (hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a"))) {
    return boundedDimensions(view.getUint16(6, true), view.getUint16(8, true)) ? "image/gif" : undefined;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor < bytes.byteLength) {
      if (bytes[cursor] !== 0xff) return undefined;
      while (cursor < bytes.byteLength && bytes[cursor] === 0xff) cursor += 1;
      if (cursor >= bytes.byteLength) return undefined;
      const marker = bytes[cursor++] as number;
      if (marker === 0xd9 || marker === 0xda || marker === 0x00) return undefined;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (cursor + 2 > bytes.byteLength) return undefined;
      const segmentLength = view.getUint16(cursor, false);
      if (segmentLength < 2 || segmentLength > bytes.byteLength - cursor) return undefined;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (segmentLength < 8) return undefined;
        const components = bytes[cursor + 7] as number;
        if (components < 1 || segmentLength !== 8 + components * 3) return undefined;
        return boundedDimensions(view.getUint16(cursor + 5, false), view.getUint16(cursor + 3, false))
          ? "image/jpeg" : undefined;
      }
      cursor += segmentLength;
    }
    return undefined;
  }
  if (bytes.byteLength < 20 || !hasAscii(bytes, 0, "RIFF") || !hasAscii(bytes, 8, "WEBP")) return undefined;
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd < 20 || riffEnd > bytes.byteLength) return undefined;
  let cursor = 12;
  while (cursor + 8 <= riffEnd) {
    const length = view.getUint32(cursor + 4, true);
    const payload = cursor + 8;
    const end = payload + length;
    if (end > riffEnd) return undefined;
    if (hasAscii(bytes, cursor, "VP8X") && length >= 10) {
      return boundedDimensions(1 + readUint24(bytes, payload + 4), 1 + readUint24(bytes, payload + 7))
        ? "image/webp" : undefined;
    }
    if (hasAscii(bytes, cursor, "VP8 ") && length >= 10
      && bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a) {
      return boundedDimensions(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff)
        ? "image/webp" : undefined;
    }
    if (hasAscii(bytes, cursor, "VP8L") && length >= 5 && bytes[payload] === 0x2f) {
      const dimensions = view.getUint32(payload + 1, true);
      return boundedDimensions(1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff))
        ? "image/webp" : undefined;
    }
    cursor = end + (length & 1);
  }
  return undefined;
}

/** Reads only the embedded image record from an unencrypted PalmDB/MOBI file.
 * The device file is never modified, text is never decompressed, and unsupported
 * or malformed files simply have no preview. EXTH 202 is a fallback when the
 * preferred EXTH 201 cover is absent or unusable.
 */
export function extractKindleBookCover(bytes: Uint8Array): KindleBookCover | undefined {
  if (bytes.byteLength < RECORD_TABLE_START + RECORD_ENTRY_BYTES || bytes.byteLength > MAX_BOOK_BYTES
    || !hasAscii(bytes, 60, "BOOKMOBI")) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordCount = view.getUint16(76, false);
  const tableEnd = RECORD_TABLE_START + recordCount * RECORD_ENTRY_BYTES;
  if (recordCount < 1 || tableEnd > bytes.byteLength) return undefined;
  const offsetAt = (index: number): number => view.getUint32(RECORD_TABLE_START + index * RECORD_ENTRY_BYTES, false);
  let previous = tableEnd - 1;
  for (let index = 0; index < recordCount; index += 1) {
    const offset = offsetAt(index);
    if (offset <= previous || offset >= bytes.byteLength) return undefined;
    previous = offset;
  }
  const recordZero = offsetAt(0);
  const recordZeroEnd = recordCount > 1 ? offsetAt(1) : bytes.byteLength;
  const mobi = recordZero + PALMDOC_HEADER_BYTES;
  if (recordZeroEnd - mobi < 116 || !hasAscii(bytes, mobi, "MOBI")
    || view.getUint16(recordZero + 12, false) !== 0) return undefined;
  const mobiLength = view.getUint32(mobi + 4, false);
  if (mobiLength < 116 || mobiLength > recordZeroEnd - mobi) return undefined;
  const exth = mobi + mobiLength;
  if (exth + 12 > recordZeroEnd || !hasAscii(bytes, exth, "EXTH")) return undefined;
  const exthLength = view.getUint32(exth + 4, false);
  const exthCount = view.getUint32(exth + 8, false);
  if (exthLength < 12 || exthLength > recordZeroEnd - exth
    || exthCount > MAX_EXTH_RECORDS || exthCount > Math.floor((exthLength - 12) / 8)) return undefined;
  const exthEnd = exth + exthLength;
  let cursor = exth + 12;
  let coverOffset: number | undefined;
  let thumbnailOffset: number | undefined;
  for (let index = 0; index < exthCount; index += 1) {
    if (cursor + 8 > exthEnd) return undefined;
    const type = view.getUint32(cursor, false);
    const length = view.getUint32(cursor + 4, false);
    if (length < 8 || length > exthEnd - cursor) return undefined;
    if (length === 12) {
      if (type === 201 && coverOffset === undefined) coverOffset = view.getUint32(cursor + 8, false);
      if (type === 202 && thumbnailOffset === undefined) thumbnailOffset = view.getUint32(cursor + 8, false);
    }
    cursor += length;
  }
  // This field is relative to the PalmDOC record start, not the MOBI header.
  const firstImageRecord = view.getUint32(recordZero + FIRST_IMAGE_RECORD_OFFSET, false);
  if (firstImageRecord < 1 || firstImageRecord >= recordCount) return undefined;
  for (const relativeOffset of [coverOffset, thumbnailOffset]) {
    if (relativeOffset === undefined) continue;
    const index = firstImageRecord + relativeOffset;
    if (index >= recordCount) continue;
    const start = offsetAt(index);
    const end = index + 1 < recordCount ? offsetAt(index + 1) : bytes.byteLength;
    const candidate = bytes.subarray(start, end);
    const mediaType = inspectKindleCoverImage(candidate);
    if (mediaType !== undefined) return { bytes: new Uint8Array(candidate), mediaType };
  }
  return undefined;
}
