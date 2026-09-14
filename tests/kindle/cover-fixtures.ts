export function coverPng(length = 33): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, 600);
  view.setUint32(20, 800);
  return bytes;
}

export function deviceBook(image = coverPng()): Uint8Array {
  const book = new Uint8Array(284 + image.length);
  const view = new DataView(book.buffer);
  const text = (offset: number, value: string): void => book.set(new TextEncoder().encode(value), offset);
  text(60, "BOOKMOBI");
  view.setUint16(76, 2);
  view.setUint32(78, 112);
  view.setUint32(86, 284);
  text(128, "MOBI");
  view.setUint32(132, 132);
  view.setUint32(112 + 0x6c, 1);
  text(260, "EXTH");
  view.setUint32(264, 24);
  view.setUint32(268, 1);
  view.setUint32(272, 201);
  view.setUint32(276, 12);
  view.setUint32(280, 0);
  book.set(image, 284);
  return book;
}
