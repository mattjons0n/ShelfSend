import type { CatalogBrowserSnapshot } from "./catalog-browser";
import { libraryIcon } from "./library-icons";
import { LIBRARY_CARD_SIZE_MIN, LIBRARY_CARD_SIZE_MAX, LIBRARY_CARD_SIZE_STEP, normalizeLibraryCardSize } from "./library-display-preferences";

/** The same display preferences and controls serve library and device views. */
export function renderLibraryLayoutControls(snapshot: CatalogBrowserSnapshot): string {
  const disabled = snapshot.sendBusy || snapshot.bulkActionBusy ? " disabled" : "";
  const density = snapshot.density ?? "comfortable";
  const sizing = snapshot.layout === "grid"
    ? `<label class="library-card-size" for="library-card-size"><span>Card size</span><span class="library-card-size-track"><span aria-hidden="true">−</span><input id="library-card-size" data-ui-action="set-library-card-size" type="range" min="${LIBRARY_CARD_SIZE_MIN}" max="${LIBRARY_CARD_SIZE_MAX}" step="${LIBRARY_CARD_SIZE_STEP}" value="${normalizeLibraryCardSize(snapshot.cardSize)}" aria-describedby="library-card-size-hint"${disabled} /><span aria-hidden="true">+</span></span><span id="library-card-size-hint" class="sr-only">Smaller to larger covers. Text stays the same readable size.</span></label>`
    : `<div class="library-layout-toggle library-density-toggle" role="group" aria-label="Book density"><button type="button" data-ui-action="set-library-density" data-density="comfortable" aria-pressed="${density === "comfortable"}" aria-label="Comfortable density" title="Comfortable"${disabled}><span aria-hidden="true">↕</span></button><button type="button" data-ui-action="set-library-density" data-density="compact" aria-pressed="${density === "compact"}" aria-label="Compact density" title="Compact"${disabled}><span aria-hidden="true">≡</span></button></div>`;
  return `<div class="library-display-controls">${sizing}<div class="library-layout-toggle" role="group" aria-label="Book layout"><button type="button" data-ui-action="set-library-layout" data-layout="grid" aria-pressed="${snapshot.layout === "grid"}" aria-label="Grid view" title="Grid view"${disabled}>${libraryIcon("grid")}</button><button type="button" data-ui-action="set-library-layout" data-layout="list" aria-pressed="${snapshot.layout === "list"}" aria-label="List view" title="List view"${disabled}>${libraryIcon("list")}</button></div></div>`;
}
