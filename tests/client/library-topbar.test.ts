// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogProfile, CatalogRoot, CatalogServiceStatus } from "../../client/src/catalog-client";
import { initialLibraryFilters } from "../../client/src/library-prototype";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { initialAppState, type AppState } from "../../client/src/state";

const PROFILE: CatalogProfile = {
  id: "prf_mattias", name: "Mattias", description: "Personal collection", initial: "M",
  sourceLabel: "Mattias library", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 0,
};
const ROOT: CatalogRoot = {
  id: "root_books", profileId: PROFILE.id, label: "Books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const SERVICE: CatalogServiceStatus = {
  available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready",
};

function render(
  view: "all" | "settings",
  overrides: Partial<CatalogBrowserSnapshot> = {},
  stateOverrides: Partial<AppState> = {},
): HTMLElement {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined);
  const initial = browser.snapshot;
  browser.dispose();
  const root = document.createElement("div");
  root.innerHTML = renderLibraryPrototype(
    { ...initialAppState(), secureContext: true, webUsbAvailable: true, ...stateOverrides },
    {
      ...initial, loadState: "ready", profiles: [PROFILE], serviceStatus: SERVICE,
      rootsByProfile: new Map([[PROFILE.id, [ROOT]]]),
      filters: { ...initialLibraryFilters(PROFILE.id), view },
      liveUpdatesConnected: true,
      ...overrides,
    },
  );
  return root;
}

describe("uncluttered library topbar", () => {
  it.each(["all", "settings"] as const)("omits the redundant breadcrumb on %s without removing useful controls", (view) => {
    const root = render(view);
    const topbar = root.querySelector(".library-topbar")!;
    expect(topbar).not.toBeNull();
    expect(root.querySelector(".library-breadcrumb")).toBeNull();
    expect(topbar.textContent).not.toContain("Your library");
    expect(topbar.textContent).not.toContain(PROFILE.name);
    expect(topbar.querySelector('.library-topbar-status[role="status"]')?.textContent).toContain("Library index up to date");
    expect(topbar.querySelector('[data-ui-action="open-activity-center"]')).not.toBeNull();
    expect(topbar.querySelector('[data-ui-action="open-send-queue"]')?.textContent).toContain("Send later");
    expect(topbar.querySelector('[data-ui-action="toggle-reader-picker"]')?.textContent).toContain("Connect eReader");
    expect(topbar.querySelector('[data-ui-action="connect-catalog-device"]')).not.toBeNull();
    expect(topbar.querySelector('[data-ui-action="connect-kobo"]')).not.toBeNull();
    expect(root.querySelector(".library-profile-list")?.textContent).toContain(PROFILE.name);
  });

  it("keeps the selected library name in the dashboard heading", () => {
    const root = render("all");
    expect(root.querySelector("#library-heading")?.textContent).toBe(PROFILE.name);
    expect(root.querySelector(".library-brand")?.textContent).toContain("ShelfSend");
  });

  describe.each(["all", "settings"] as const)("header action order in %s", (view) => {
    it.each<[string, Partial<CatalogBrowserSnapshot>, Partial<AppState>, string]>([
      ["disconnected reader picker", {}, {}, "toggle-reader-picker"],
      ["connected Kindle", {}, {
        device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      }, "show-kindle"],
      ["connected Kobo", {
        activeReader: "kobo",
        kobo: { status: "ready", supported: true, statuses: new Map(), countsByProfile: new Map() },
      }, {}, "show-kindle"],
    ])("places Activity last in DOM and natural tab order with a %s", (_label, snapshot, state, connectionAction) => {
      const topbar = render(view, snapshot, state).querySelector(".library-topbar")!;
      const activity = topbar.querySelector<HTMLButtonElement>('[data-ui-action="open-activity-center"]')!;
      expect(topbar.lastElementChild).toBe(activity);

      // Native tab order must follow the visible order, without CSS-only
      // rearrangement or positive tabindex values hiding an accessibility mismatch.
      const visibleButtons = Array.from(topbar.querySelectorAll<HTMLButtonElement>("button"))
        .filter((button) => !button.closest("[hidden]"));
      expect(visibleButtons.map((button) => button.dataset.uiAction)).toEqual([
        "refresh-library", connectionAction, "open-send-queue", "open-activity-center",
      ]);
      for (const button of visibleButtons) expect(button.tabIndex).toBe(0);
    });
  });

  it.each(["all", "settings"] as const)("groups the index status and accessible refresh icon first in the %s topbar", (view) => {
    const root = render(view);
    const topbar = root.querySelector(".library-topbar")!;
    const sync = topbar.querySelector(".library-topbar-sync")!;
    const status = sync.querySelector('.library-topbar-status[role="status"]')!;
    const refresh = sync.querySelector<HTMLButtonElement>('[data-ui-action="refresh-library"]')!;

    expect(topbar.firstElementChild).toBe(sync);
    expect(status.parentElement).toBe(refresh.parentElement);
    expect(status.textContent).toContain("Library index up to date");
    expect(refresh.tagName).toBe("BUTTON");
    expect(refresh.type).toBe("button");
    expect(refresh.getAttribute("aria-label")).toBe("Refresh and sync library");
    expect(refresh.disabled).toBe(false);
    expect(refresh.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(refresh.textContent?.trim()).toBe("");
    expect(root.querySelectorAll('[data-ui-action="refresh-library"]')).toHaveLength(1);
    expect(root.querySelectorAll(".library-topbar-status")).toHaveLength(1);
  });

  it.each<[string, Partial<CatalogBrowserSnapshot>]>([
    ["no profile", { profiles: [], rootsByProfile: new Map() }],
    ["disabled profile", { profiles: [{ ...PROFILE, enabled: false }] }],
    ["unloaded roots", { rootsByProfile: new Map() }],
    ["no roots", { rootsByProfile: new Map([[PROFILE.id, []]]) }],
    ["disabled roots", { rootsByProfile: new Map([[PROFILE.id, [{ ...ROOT, enabled: false }]]]) }],
    ["initial catalog state", { loadState: "idle" }],
    ["catalog loading", { loadState: "loading" }],
    ["catalog error", { loadState: "error" }],
    ["database error", { serviceStatus: { ...SERVICE, database: "error" } }],
    ["service unavailable", { serviceStatus: { ...SERVICE, state: "unavailable" } }],
    ["settings save", { settingsSaving: true }],
    ["settings refresh", { settingsRefreshing: true }],
    ["book transfer", { sendBusy: true }],
    ["bulk operation", { bulkActionBusy: true }],
  ])("disables manual refresh during %s", (_name, overrides) => {
    const root = render("all", overrides);
    const refresh = root.querySelector<HTMLButtonElement>('[data-ui-action="refresh-library"]')!;
    expect(refresh).not.toBeNull();
    expect(refresh.disabled).toBe(true);
  });

  it.each<[string, Partial<CatalogBrowserSnapshot>]>([
    ["manual refresh", { libraryRefreshing: true }],
    ["active source scan", { rootsByProfile: new Map([[PROFILE.id, [{ ...ROOT, status: "scanning" }]]]) }],
    ["pending source scan", { rescanningRootIds: new Set([ROOT.id]) }],
  ])("shows the busy icon and prevents duplicate requests during %s", (_name, overrides) => {
    const root = render("all", overrides);
    const refresh = root.querySelector<HTMLButtonElement>('[data-ui-action="refresh-library"]')!;
    expect(refresh.disabled).toBe(true);
    expect(refresh.dataset.refreshing).toBe("true");
  });

  it("explains a manual refresh beside its icon", () => {
    const root = render("all", { libraryRefreshing: true });
    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Checking library…");
  });

  it("keeps a refresh failure visible and offers retry", () => {
    const root = render("all", { libraryRefreshError: "The library check could not finish." });
    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Library refresh needs attention");
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="refresh-library"]')?.disabled).toBe(false);
  });

  it("does not block checking this library for another library's source scan", () => {
    const root = render("all", {
      rootsByProfile: new Map([
        [PROFILE.id, [ROOT]],
        ["prf_other", [{ ...ROOT, id: "root_other", profileId: "prf_other", status: "scanning" }]],
      ]),
      rescanningRootIds: new Set(["root_other"]),
    });
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="refresh-library"]')?.disabled).toBe(false);
  });

  it("allows retrying unavailable enabled sources and preserves read-only settings policy", () => {
    const root = render("all", {
      profiles: [{ ...PROFILE, availableRootCount: 0 }],
      rootsByProfile: new Map([[PROFILE.id, [{ ...ROOT, status: "unavailable" }]]]),
      serviceStatus: { ...SERVICE, settingsMode: "read-only" },
    });
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="refresh-library"]')?.disabled).toBe(false);
    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Library sources unavailable");
  });
});
