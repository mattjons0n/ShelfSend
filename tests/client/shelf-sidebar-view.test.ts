// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogApi, SmartShelf } from "../../client/src/catalog-client";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { initialLibraryFilters } from "../../client/src/library-prototype";
import { initialAppState } from "../../client/src/state";
import { BUILT_IN_SMART_SHELVES } from "../../client/src/smart-shelves";

const profileId = "prf_home";
const custom: SmartShelf = {
  id: "shelf_fantasy01", profileId, name: "Fantasy", query: { version: 1 }, pinnedRank: 0,
  revision: 1, serverCount: 3, createdAt: "2026-09-01", updatedAt: "2026-09-01",
};
const ids = BUILT_IN_SMART_SHELVES.map(({ id }) => id);
function render(extra: Partial<CatalogBrowserSnapshot> = {}) {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined);
  const initial = browser.snapshot; browser.dispose();
  const root = document.createElement("div");
  root.innerHTML = renderLibraryPrototype(initialAppState(), {
    ...initial, loadState: "ready", profiles: [{ id: profileId, name: "Home", description: "Books", initial: "H", sourceLabel: "Books", enabled: true, rootCount: 0, availableRootCount: 0, bookCount: 0 }],
    filters: initialLibraryFilters(profileId), smartShelves: [custom], smartShelvesState: "ready", shelfManagerOpen: true,
    sidebarShelfOrder: { profileId, revision: 1, shelfIds: [...ids, custom.id] }, sidebarShelfOrderState: "ready",
    ...extra,
  });
  return root;
}
function orderedIds(root: HTMLElement, list: string) {
  return [...root.querySelectorAll(`[data-shelf-order-list="${list}"] [data-sidebar-shelf-id]`)].map((row) => row.getAttribute("data-sidebar-shelf-id"));
}

describe("visible and reorderable sidebar shelves", () => {
  it("hides disabled Read books everywhere without dropping other built-in or custom shelves", () => {
    const root = render();
    expect(root.querySelector('[data-shelf-id="builtin-read-books"], [data-sidebar-shelf-id="builtin-read-books"]')).toBeNull();
    expect(root.querySelector(".library-shelf-list")?.textContent).not.toContain("Read books");
    expect(root.querySelector(".library-shelf-sheet")?.textContent).not.toContain("Read books");
    expect(orderedIds(root, "sidebar")).toEqual([...ids.filter((id) => id !== "builtin-read-books"), custom.id]);
    expect(orderedIds(root, "manager")).toEqual(orderedIds(root, "sidebar"));
    expect(root.querySelector('[data-ui-action="delete-smart-shelf"][data-shelf-id="builtin-favorites"]')).toBeNull();
  });

  it("can show the read shelf when the validated reading feature is enabled", () => {
    expect(orderedIds(render({ readingEnabled: true }), "sidebar")[0]).toBe("builtin-read-books");
  });

  it("uses the same saved mixed built-in/custom order in the sidebar and manager", () => {
    const order = ["builtin-favorites", custom.id, ...ids.filter((id) => id !== "builtin-favorites")];
    const root = render({ sidebarShelfOrder: { profileId, revision: 4, shelfIds: order } });
    const expected = order.filter((id) => id !== "builtin-read-books");
    expect(orderedIds(root, "sidebar")).toEqual(expected);
    expect(orderedIds(root, "manager")).toEqual(expected);
    const list = root.querySelector('[data-shelf-order-list="manager"]')!;
    expect(list.querySelector<HTMLButtonElement>('[data-shelf-id="builtin-favorites"][data-direction="-1"]')?.disabled).toBe(true);
    expect(list.querySelector<HTMLButtonElement>('[data-shelf-id="builtin-missing-cover"][data-direction="1"]')?.disabled).toBe(true);
    expect(list.querySelector<HTMLButtonElement>(`[data-shelf-id="${custom.id}"][data-direction="-1"]`)?.disabled).toBe(false);
  });

  it("provides native labeled handles and a fixed Manage shelves action outside the reordered rows", () => {
    const root = render();
    const handle = root.querySelector<HTMLButtonElement>('.library-shelf-row [data-shelf-drag-handle]')!;
    expect(handle.tagName).toBe("BUTTON");
    expect(handle.draggable).toBe(true);
    expect(handle.getAttribute("aria-label")).toBe("Reorder Recently added");
    const manage = root.querySelector('.library-shelf-item.manage')!;
    expect(manage.closest('[data-sidebar-shelf-id]')).toBeNull();
    expect(root.querySelector('.shelf-order-feedback')?.textContent).toContain("saved for this library");
  });

  it.each([
    { sidebarShelfOrderBusy: true }, { sidebarShelfOrderState: "loading" }, { sidebarShelfOrderState: "error" },
    { sendBusy: true }, { bulkActionBusy: true }, { smartShelvesState: "loading" },
  ] satisfies Partial<CatalogBrowserSnapshot>[])("disables ordering during %j without disabling shelf browsing", (state) => {
    const root = render(state);
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-shelf-drag-handle], [data-ui-action="move-sidebar-shelf"]')) {
      expect(button.disabled).toBe(true);
      if (button.hasAttribute("data-shelf-drag-handle")) expect(button.draggable).toBe(false);
    }
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="apply-smart-shelf"]')?.disabled).toBe(false);
  });

  it("shows recoverable errors and ignores another library's order", () => {
    const root = render({ sidebarShelfOrder: { profileId: "prf_other", revision: 2, shelfIds: [custom.id, ...ids] }, sidebarShelfOrderState: "error", sidebarShelfOrderError: "The order changed in another browser. Try again." });
    expect(orderedIds(root, "sidebar")[0]).toBe("builtin-recent");
    expect(root.querySelector('.shelf-order-error[role="alert"]')?.textContent).toContain("another browser");
    expect(root.querySelector('[data-ui-action="retry-shelf-order"]')).not.toBeNull();
  });
});
