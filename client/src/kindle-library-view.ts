import type { CatalogBrowserSnapshot, CatalogKindleInventoryItem } from "./catalog-browser";
import { libraryIcon } from "./library-icons";
import { formatCatalogBytes } from "./library-prototype";
import { normalizeLibraryCardSize } from "./library-display-preferences";
import { renderLibraryLayoutControls } from "./library-layout-controls";
import type { AppState } from "./state";

const PAGE_SIZE = 100;

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function itemTitle(item: CatalogKindleInventoryItem): string {
  return item.title?.trim() || item.filename;
}

function itemAuthors(item: CatalogKindleInventoryItem): string {
  return item.authors?.map((author) => author.trim()).filter(Boolean).join(", ")
    || item.author?.trim() || "Author unavailable";
}

function itemFormat(item: CatalogKindleInventoryItem): string {
  return item.format?.trim().toLocaleUpperCase()
    || item.filename.match(/\.([a-z\d]{1,8})$/i)?.[1]?.toLocaleUpperCase()
    || "File";
}

function scannedTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "Scan time unavailable";
  if (elapsed < 60_000) return "Checked just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Checked ${hours} hr ago` : `Checked ${Math.floor(hours / 24)} days ago`;
}

function renderItem(item: CatalogKindleInventoryItem): string {
  return `<li class="kindle-library-item" data-kindle-object-id="${escapeHtml(item.id)}">
    <span class="kindle-library-icon" data-kindle-cover aria-hidden="true">${libraryIcon("book")}</span>
    <div class="kindle-library-book"><h2>${escapeHtml(itemTitle(item))}</h2><p>${escapeHtml(itemAuthors(item))}</p><small>${escapeHtml(itemFormat(item))} · ${escapeHtml(formatCatalogBytes(item.size))}</small></div>
    <details class="kindle-library-file-details"><summary>File details<span class="sr-only"> for ${escapeHtml(itemTitle(item))}</span></summary><dl><div><dt>Filename</dt><dd>${escapeHtml(item.filename)}</dd></div>${item.path ? `<div><dt>Location on Kindle</dt><dd>${escapeHtml(item.path)}</dd></div>` : ""}</dl></details>
  </li>`;
}

/** Device-owned contents only. Library filters and match evidence never determine membership. */
export function renderKindleLibraryView(state: AppState, snapshot: CatalogBrowserSnapshot): string {
  const layout = snapshot.layout === "list" ? "list" : "grid";
  const density = snapshot.density === "compact" ? "compact" : "comfortable";
  const inventory = snapshot.kindleInventory;
  const connected = state.device.kind === "ready" || state.device.kind === "transferring";
  const disconnecting = state.device.kind === "recovering";
  const disconnectBlocked = disconnecting || snapshot.sendBusy || snapshot.bulkActionBusy
    || state.postConnectStage !== "idle" || state.selfTest.kind === "running" || state.device.kind === "transferring";
  const disconnectButton = connected || disconnecting
    ? `<button type="button" data-ui-action="disconnect-catalog-device"${disconnectBlocked ? " disabled" : ""}>${disconnecting ? "Disconnecting…" : "Disconnect"}</button>`
    : "";
  const loading = connected && state.catalogInventoryState === "loading";
  const failed = connected && state.catalogInventoryState === "failed";
  const lastSeen = Boolean(inventory && (!connected || inventory.completeness === "last-seen"));
  const partial = Boolean(inventory && (inventory.completeness === "partial" || inventory.truncated
    || inventory.total > inventory.items.length));
  const status = lastSeen ? "last-seen" : failed ? "failed" : loading ? "loading"
    : !inventory ? "unavailable" : partial ? "partial" : "complete";
  const statusLabel = status === "last-seen" ? "Last available list"
    : status === "failed" ? "Check interrupted"
    : status === "loading" ? "Checking Kindle…"
    : status === "partial" ? "Some contents may be missing"
    : status === "complete" ? "Contents up to date"
    : connected ? "Waiting for Kindle contents" : "Kindle not connected";
  const query = snapshot.kindleInventoryQuery ?? "";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = inventory?.items ?? [];
  const matchingItems = items.filter((item) => !normalizedQuery || [item.title, item.author,
    ...(item.authors ?? []), item.filename, item.format, item.path]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedQuery));
  const maxOffset = Math.max(0, Math.floor((matchingItems.length - 1) / PAGE_SIZE) * PAGE_SIZE);
  const requestedOffset = Number.isFinite(snapshot.kindleInventoryOffset)
    ? Math.floor(snapshot.kindleInventoryOffset / PAGE_SIZE) * PAGE_SIZE : 0;
  const offset = Math.min(maxOffset, Math.max(0, requestedOffset));
  const shown = matchingItems.slice(offset, offset + PAGE_SIZE);
  const notices: string[] = [];
  if (lastSeen) notices.push("This is the last available list, not a current check. Reconnect your Kindle to update it.");
  else if (failed) notices.push(inventory
    ? "The latest check could not finish. Your last available list is still shown. Disconnect and reconnect your Kindle to try again."
    : "The Kindle contents could not be read. Disconnect and reconnect your Kindle to try again.");
  else if (loading && inventory) notices.push("Checking your Kindle. The last available list stays visible while it updates.");
  if (partial) notices.push(inventory?.truncated
    ? "The check reached its limit. These are the books and documents found so far; other files may not be listed."
    : "The check is incomplete. These are the books and documents found so far; other files may not be listed.");
  if (inventory?.metadata && inventory.metadata.status !== "complete") {
    notices.push(loading && state.postConnectStage === "inventory"
      ? "Book titles and authors are still being read. Files without those details are shown by filename."
      : "Some titles and authors are unavailable. Those files are still listed by filename.");
  }
  const emptyTitle = !inventory ? connected ? failed ? "Unable to read Kindle contents" : "Reading your Kindle…" : "Connect your Kindle"
    : normalizedQuery && items.length > 0 ? "No matching books or documents"
    : lastSeen ? "No files in the last available list"
    : failed || loading || partial ? "No files available yet" : "No books or documents found";
  const emptyMessage = !inventory ? connected ? failed ? "Reconnect your Kindle to try again." : "Its books and documents will appear here when the check finishes."
    : "Use Connect eReader above to see the books and documents on your Kindle."
    : normalizedQuery && items.length > 0 ? "Try another title, author, or filename. This search only checks your Kindle."
    : lastSeen ? "Reconnect your Kindle to read its current contents."
    : failed || loading || partial ? "A complete Kindle check is needed before this list can be confirmed."
    : "The completed check found no supported book or document files on this Kindle.";
  const summary = normalizedQuery
    ? `${matchingItems.length.toLocaleString()} of ${items.length.toLocaleString()} files match your search`
    : `${items.length.toLocaleString()} ${items.length === 1 ? "book or document" : "books and documents"}${lastSeen || failed || loading ? " in the last available list" : partial ? " found so far" : ""}`;
  return `<section class="kindle-library-view" data-layout="${layout}" data-density="${density}" aria-labelledby="kindle-library-heading">
    <header class="kindle-library-heading"><div><span class="library-eyebrow">Device library</span><h1 id="kindle-library-heading">On Device</h1><p>Books and documents on your Kindle, including those outside your libraries.</p></div><div class="kindle-library-actions"><span class="kindle-library-status" data-state="${status}" role="status">${statusLabel}</span>${disconnectButton}</div></header>
    ${notices.map((notice) => `<p class="kindle-library-notice" role="status">${escapeHtml(notice)}</p>`).join("")}
    <div class="kindle-library-toolbar"><label class="kindle-library-search"><span class="sr-only">Search Kindle contents</span>${libraryIcon("search")}<input id="kindle-inventory-search" data-ui-action="search-kindle-inventory" type="search" value="${escapeHtml(query)}" placeholder="Search Kindle by title, author, or filename…" autocomplete="off" /></label>${renderLibraryLayoutControls(snapshot)}</div>
    ${inventory ? `<div class="kindle-library-summary"><span>${escapeHtml(summary)}</span><span>${escapeHtml(scannedTime(inventory.scannedAt))}</span></div>` : ""}
    ${shown.length ? `<ul class="kindle-library-list library-book-grid" data-layout="${layout}" style="--library-card-min-width: ${normalizeLibraryCardSize(snapshot.cardSize)}px">${shown.map(renderItem).join("")}</ul>` : `<div class="kindle-library-empty"><span aria-hidden="true">${libraryIcon("device")}</span><h2>${emptyTitle}</h2><p>${emptyMessage}</p></div>`}
    ${matchingItems.length > PAGE_SIZE ? `<nav class="kindle-library-pagination" aria-label="Kindle content pages"><button type="button" data-ui-action="kindle-page" data-page-offset="${Math.max(0, offset - PAGE_SIZE)}"${offset === 0 ? " disabled" : ""}>Previous</button><span>${(offset + 1).toLocaleString()}–${Math.min(offset + PAGE_SIZE, matchingItems.length).toLocaleString()} of ${matchingItems.length.toLocaleString()}</span><button type="button" data-ui-action="kindle-page" data-page-offset="${Math.min(maxOffset, offset + PAGE_SIZE)}"${offset === maxOffset ? " disabled" : ""}>Next</button></nav>` : ""}
  </section>`;
}
