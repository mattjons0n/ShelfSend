/** Read-only Hardcover discovery. These identities never authorize Kindle writes. */
export interface HardcoverSeriesMembership {
  id: number;
  name: string;
  position: number | null;
}

export interface HardcoverBook {
  id: number;
  title: string;
  authors: string[];
  identifiers: string[];
  url: string | null;
  coverUrl: string | null;
  releaseYear: number | null;
  series: HardcoverSeriesMembership[];
}

export interface HardcoverBookLookup {
  books: HardcoverBook[];
  matchedBookId: number | null;
}

export interface HardcoverSeriesBook extends HardcoverBook {
  position: number | null;
}

export interface HardcoverSeriesPage {
  id: number;
  name: string;
  books: HardcoverSeriesBook[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface HardcoverLibraryMatch {
  status: "in-library" | "missing" | "possible";
  books: Array<{ id: string; title: string; available: boolean; coverUrl: string | null }>;
}

export interface HardcoverLibrarySeriesPage extends Omit<HardcoverSeriesPage, "books"> {
  books: Array<HardcoverSeriesBook & { library: HardcoverLibraryMatch }>;
}
