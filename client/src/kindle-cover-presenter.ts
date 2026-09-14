import type { CatalogKindleInventoryItem } from "./catalog-browser";
import type { KindleBookCover } from "./kindle/book-cover";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;
const THUMBNAIL_DIMENSION = 240;
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_IMAGES = 120;
const MAX_MISSING_ITEMS = 512;
const FALLBACK_VISIBLE_LIMIT = 12;

function boundedDecode<T>(operation: Promise<T>, releaseLate?: (result: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timeout = window.setTimeout(() => {
      expired = true;
      reject(new Error("Cover image decode timed out"));
    }, 5_000);
    operation.then((result) => {
      window.clearTimeout(timeout);
      if (expired) releaseLate?.(result);
      else resolve(result);
    }, (error: unknown) => {
      window.clearTimeout(timeout);
      reject(error);
    });
  });
}

/** These are exact live object facts, never a catalog identity or title match. */
export function kindleCoverFingerprint(item: CatalogKindleInventoryItem): string {
  return JSON.stringify([item.id, item.path ?? null, item.objectFormat ?? null,
    item.size, item.modificationDate ?? null]);
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
}

/** The file parser bounds dimensions before decode. Check again and retain only
 * a small, browser-generated raster, with no device bytes sent to a server. */
export async function prepareKindleCoverThumbnail(cover: KindleBookCover): Promise<Blob | undefined> {
  if (!cover.bytes.byteLength || cover.bytes.byteLength > MAX_IMAGE_BYTES
    || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(cover.mediaType)) return undefined;
  const source = new Blob([new Uint8Array(cover.bytes)], { type: cover.mediaType });
  let bitmap: ImageBitmap | undefined;
  let sourceUrl: string | undefined;
  try {
    let drawable: ImageBitmap | HTMLImageElement;
    if (typeof createImageBitmap === "function") {
      bitmap = await boundedDecode(createImageBitmap(source), (late) => late.close());
      drawable = bitmap;
    } else {
      const image = new Image();
      if (typeof image.decode !== "function") return undefined;
      sourceUrl = URL.createObjectURL(source);
      image.src = sourceUrl;
      await boundedDecode(image.decode());
      drawable = image;
    }
    const width = drawable instanceof HTMLImageElement ? drawable.naturalWidth : drawable.width;
    const height = drawable instanceof HTMLImageElement ? drawable.naturalHeight : drawable.height;
    if (!validDimensions(width, height)) return undefined;
    const scale = Math.min(1, THUMBNAIL_DIMENSION / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    return await boundedDecode(new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob && blob.size <= MAX_CACHED_BYTES ? blob : undefined), "image/png");
    }));
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}

interface CachedThumbnail {
  readonly url: string;
  readonly bytes: number;
}

/** Ephemeral, session-scoped decoration. It only changes image nodes, leaving
 * file details, keyboard focus, search and scroll untouched. */
export class KindleCoverPresenter {
  readonly #root: HTMLElement;
  readonly #request: (itemId: string) => Promise<KindleBookCover | undefined>;
  readonly #prepare: (cover: KindleBookCover) => Promise<Blob | undefined>;
  readonly #cache = new Map<string, CachedThumbnail>();
  readonly #missing = new Map<string, number>();
  #cachedBytes = 0;
  #items = new Map<string, CatalogKindleInventoryItem>();
  #rows = new Map<string, HTMLElement>();
  #visible = new Set<string>();
  #attemptedOnPage = new Set<string>();
  #observer?: IntersectionObserver;
  #enabled = false;
  #pageKey = "";
  #epoch = 0;
  #observation = 0;
  #reading = false;
  #scheduled = false;
  #disposed = false;
  #fallbackListening = false;
  #lastItems?: readonly CatalogKindleInventoryItem[];
  #lastPage?: Element | null;
  readonly #fallbackChanged = () => this.#measureVisible();

  constructor(root: HTMLElement, request: (itemId: string) => Promise<KindleBookCover | undefined>,
    prepare = prepareKindleCoverThumbnail) {
    this.#root = root;
    this.#request = request;
    this.#prepare = prepare;
  }

  update(items: readonly CatalogKindleInventoryItem[], enabled: boolean, pageKey: string): void {
    if (this.#disposed) return;
    const page = this.#root.querySelector(".kindle-library-view");
    if (this.#lastItems === items && this.#lastPage === page && this.#enabled === enabled && this.#pageKey === pageKey) {
      // Progress publications and hardware-lane unlocks do not rebuild a
      // 10,000-item fingerprint map or replace visibility observations.
      this.#schedule();
      return;
    }
    this.#lastItems = items;
    this.#lastPage = page;
    if (this.#enabled !== enabled || this.#pageKey !== pageKey) this.#epoch += 1;
    if (this.#pageKey !== pageKey) this.#attemptedOnPage.clear();
    this.#enabled = enabled;
    this.#pageKey = pageKey;
    this.#items = new Map(items.map((item) => [kindleCoverFingerprint(item), item]));
    for (const key of this.#cache.keys()) if (!this.#items.has(key)) this.#evict(key);
    for (const key of this.#missing.keys()) if (!this.#items.has(key)) this.#missing.delete(key);
    for (const key of this.#attemptedOnPage) if (!this.#items.has(key)) this.#attemptedOnPage.delete(key);
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#removeFallbackListeners();
    this.#visible.clear();
    this.#rows.clear();
    const observation = ++this.#observation;
    const byId = new Map(items.map((item) => [item.id, item]));
    this.#root.querySelectorAll<HTMLElement>(".kindle-library-view [data-kindle-object-id]").forEach((row) => {
      const item = byId.get(row.dataset.kindleObjectId ?? "");
      if (!item) return;
      const key = kindleCoverFingerprint(item);
      this.#rows.set(key, row);
      const cached = this.#cache.get(key);
      if (cached) this.#show(key, cached);
      else this.#clearImage(row);
    });
    if (!enabled || this.#rows.size === 0) return;
    if (typeof IntersectionObserver === "function") {
      this.#observer = new IntersectionObserver((entries) => {
        if (observation !== this.#observation || !this.#enabled) return;
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          const item = byId.get(row.dataset.kindleObjectId ?? "");
          if (!item) continue;
          const key = kindleCoverFingerprint(item);
          if (this.#rows.get(key) !== row) continue;
          if (entry.isIntersecting) this.#visible.add(key);
          else this.#visible.delete(key);
        }
        this.#schedule();
      }, { rootMargin: "80px 0px" });
      for (const row of this.#rows.values()) this.#observer.observe(row);
    } else {
      window.addEventListener("scroll", this.#fallbackChanged, { passive: true });
      window.addEventListener("resize", this.#fallbackChanged, { passive: true });
      this.#fallbackListening = true;
      this.#measureVisible();
    }
  }

  /** Leaving this page must not inspect the DOM or walk the device inventory.
   * Keep only bounded cached decoration for a later, freshly checked entry. */
  pause(): void {
    if (this.#enabled) this.#epoch += 1;
    this.#enabled = false;
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#removeFallbackListeners();
    this.#visible.clear();
    this.#rows.clear();
    this.#lastPage = undefined;
  }

  reset(): void {
    this.#epoch += 1;
    this.#observation += 1;
    this.#enabled = false;
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#removeFallbackListeners();
    this.#visible.clear();
    for (const key of this.#cache.keys()) this.#evict(key);
    this.#missing.clear();
    this.#attemptedOnPage.clear();
    this.#rows.clear();
    this.#items.clear();
    this.#lastItems = undefined;
    this.#lastPage = undefined;
  }

  dispose(): void {
    this.reset();
    this.#disposed = true;
  }

  #removeFallbackListeners(): void {
    if (!this.#fallbackListening) return;
    window.removeEventListener("scroll", this.#fallbackChanged);
    window.removeEventListener("resize", this.#fallbackChanged);
    this.#fallbackListening = false;
  }

  #measureVisible(): void {
    this.#visible.clear();
    if (!this.#enabled) return;
    for (const [key, row] of this.#rows) {
      const bounds = row.getBoundingClientRect();
      if (bounds.height > 0 && bounds.bottom >= 0 && bounds.top <= window.innerHeight) this.#visible.add(key);
      if (this.#visible.size >= FALLBACK_VISIBLE_LIMIT) break;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled || this.#reading || !this.#enabled || this.#disposed) return;
    this.#scheduled = true;
    window.setTimeout(() => {
      this.#scheduled = false;
      void this.#readNext();
    });
  }

  #current(key: string, epoch: number): boolean {
    return !this.#disposed && this.#enabled && this.#epoch === epoch
      && this.#items.has(key) && this.#rows.get(key)?.isConnected === true && this.#root.isConnected;
  }

  async #readNext(): Promise<void> {
    if (this.#reading || !this.#enabled || this.#disposed || !this.#root.isConnected) return;
    const key = [...this.#visible].find((candidate) => !this.#cache.has(candidate)
      && !this.#attemptedOnPage.has(candidate)
      && (this.#missing.get(candidate) ?? 0) < Date.now());
    if (!key) return;
    const item = this.#items.get(key);
    const epoch = this.#epoch;
    if (!item || !this.#current(key, epoch)) return;
    this.#reading = true;
    let busy = false;
    try {
      const cover = await this.#request(item.id);
      if (!this.#current(key, epoch)) return;
      const thumbnail = cover ? await this.#prepare(cover) : undefined;
      if (!this.#current(key, epoch)) return;
      if (!thumbnail || !thumbnail.size || thumbnail.size > MAX_CACHED_BYTES) {
        this.#markMissing(key);
        return;
      }
      const cached = { url: URL.createObjectURL(thumbnail), bytes: thumbnail.size };
      this.#cache.set(key, cached);
      this.#attemptedOnPage.add(key);
      this.#cachedBytes += cached.bytes;
      while (this.#cache.size > MAX_CACHED_IMAGES || this.#cachedBytes > MAX_CACHED_BYTES) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#evict(oldest);
      }
      this.#show(key, cached);
    } catch (error) {
      busy = typeof error === "object" && error !== null && "code" in error && error.code === "KINDLE_OPERATION_BUSY";
      if (!busy && this.#current(key, epoch)) this.#markMissing(key);
    } finally {
      this.#reading = false;
      if (!busy) this.#schedule();
    }
  }

  #markMissing(key: string): void {
    // Temporary busy/skip responses can be retried after a later publication;
    // repeated renders of genuinely missing covers do not reread whole books.
    this.#missing.delete(key);
    this.#missing.set(key, Date.now() + 30_000);
    if (this.#missing.size > MAX_MISSING_ITEMS) this.#missing.delete(this.#missing.keys().next().value!);
  }

  #show(key: string, cached: CachedThumbnail): void {
    const row = this.#rows.get(key);
    const slot = row?.querySelector<HTMLElement>("[data-kindle-cover]");
    if (!row || !slot) return;
    this.#cache.delete(key);
    this.#cache.set(key, cached);
    const previous = slot.querySelector<HTMLImageElement>("img[data-kindle-cover-image]");
    if (previous?.getAttribute("src") === cached.url) return;
    this.#clearImage(row);
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.dataset.kindleCoverImage = "";
    image.addEventListener("load", () => {
      if (image.parentElement === slot) slot.classList.add("has-cover");
    }, { once: true });
    image.addEventListener("error", () => {
      if (this.#cache.get(key)?.url !== cached.url) return;
      this.#evict(key);
      this.#markMissing(key);
    }, { once: true });
    image.src = cached.url;
    slot.append(image);
  }

  #clearImage(row: HTMLElement): void {
    const slot = row.querySelector<HTMLElement>("[data-kindle-cover]");
    slot?.querySelector("img[data-kindle-cover-image]")?.remove();
    slot?.classList.remove("has-cover");
  }

  #evict(key: string): void {
    const cached = this.#cache.get(key);
    if (!cached) return;
    this.#cache.delete(key);
    this.#cachedBytes -= cached.bytes;
    URL.revokeObjectURL(cached.url);
    const row = this.#rows.get(key);
    if (row) this.#clearImage(row);
  }
}
