import { crc32 } from "node:zlib";

const encoder = new TextEncoder();

export function zipFixture(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
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

export function epubFixture(extra: Readonly<Record<string, string | Uint8Array>> = {}, additionalMetadata = ""): Uint8Array {
  return zipFixture({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/book.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:original-book</dc:identifier><dc:title>Original title</dc:title><dc:creator>Original Author</dc:creator><dc:language>en</dc:language>' + additionalMetadata + '</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="font" href="font.ttf" media-type="font/ttf"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    "OPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>Original text</p></body></html>',
    "OPS/font.ttf": new Uint8Array([1, 2, 3, 4]),
    ...extra,
  });
}
