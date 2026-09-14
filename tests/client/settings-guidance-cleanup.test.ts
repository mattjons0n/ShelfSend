// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { settingsDraftFromProfile } from "../../client/src/library-settings-prototype";
import { initialAppState } from "../../client/src/state";

const PROFILE: CatalogProfile = {
  id: "prf_home", name: "Home library", description: "Books at home", initial: "H",
  sourceLabel: "books", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 0,
};
const FOLDER: CatalogRoot = {
  id: "root_books", profileId: PROFILE.id, label: "books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const ACCESS_NOTE = "Anyone who can open ShelfSend can access all libraries. Use a trusted home network or VPN.";

function snapshot(overrides: Partial<CatalogBrowserSnapshot> = {}): CatalogBrowserSnapshot {
  return {
    loadState: "ready",
    serviceStatus: { available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" },
    profiles: [PROFILE], rootsByProfile: new Map([[PROFILE.id, [FOLDER]]]),
    filters: { ...initialLibraryFilters(PROFILE.id), view: "settings" }, facets: EMPTY_CATALOG_FILTERS,
    booksState: "ready", stale: false, liveUpdatesConnected: true,
    settingsLibraryId: PROFILE.id, settingsDraft: settingsDraftFromProfile(PROFILE, [FOLDER]),
    settingsSaving: false, settingsRefreshing: false, settingsConflict: false, settingsDirty: false,
    rescanningRootIds: new Set(), sendBusy: false, kindleStatus: new Map(),
    kindleStatusCountsByProfile: new Map(), kindleInventoryOffset: 0,
    layout: "grid", selectedBookIds: new Set(), bulkActionBusy: false,
    sendQueueState: "ready", sendQueueOpen: false, sendQueueBusy: false,
    seriesState: "idle", seriesQuery: "", seriesSort: "name",
    smartShelves: [], smartShelvesState: "ready", shelfManagerOpen: false, annotations: new Map(),
    healthState: "ready", healthBooks: new Map(), healthFilter: { type: "all", severity: "all", ignored: false },
    metadataLookupState: "ready", metadataLookupBusy: false, activityOpen: false, activityEvents: [],
    ...overrides,
  };
}

function renderSettings(overrides: Partial<CatalogBrowserSnapshot> = {}): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderLibraryPrototype(initialAppState(), snapshot(overrides));
  return root.querySelector<HTMLElement>(".settings-page")!;
}

describe("concise Settings guidance", () => {
  it("replaces duplicate feature banners and cards with one plain access note", () => {
    const settings = renderSettings();
    for (const text of ["Saved on this server", "No private accounts", "Automatic indexing", "Private network only", "Safe source policy"]) {
      expect(settings.textContent).not.toContain(text);
    }
    expect(settings.querySelector(".settings-guidance")).toBeNull();
    expect(settings.querySelector(".settings-prototype-notice")).toBeNull();
    const notes = settings.querySelectorAll(".settings-access-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].getAttribute("role")).toBe("note");
    expect(notes[0].textContent).toContain(ACCESS_NOTE);
    expect(notes[0].tagName).toBe("P");
    expect(notes[0].querySelector("button")).toBeNull();
  });

  it("keeps read-only mount guidance beside the folder path and all editing controls", () => {
    const settings = renderSettings();
    const help = settings.querySelector(".settings-path-field small")?.textContent;
    expect(help).toContain("read-only");
    expect(help).toContain("container");
    expect(help).toContain("host paths");
    expect(help).toContain("won't work");
    for (const action of ["new-library", "add-settings-folder", "rescan-settings-folder", "save-library-settings", "cancel-library-settings", "onboarding-open"]) {
      const button = settings.querySelector<HTMLButtonElement>(`[data-ui-action="${action}"]`);
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);
    }
  });

  it("still explains locked Settings and allows checking an existing source", () => {
    const settings = renderSettings({ serviceStatus: { ...snapshot().serviceStatus!, settingsMode: "read-only" } });
    expect(settings.querySelector(".settings-locked-notice[role=status]")?.textContent).toContain("Settings locked");
    expect(settings.querySelector<HTMLInputElement>("#settings-library-name")?.disabled).toBe(true);
    expect(settings.querySelector<HTMLButtonElement>('[data-ui-action="save-library-settings"]')?.disabled).toBe(true);
    expect(settings.querySelector<HTMLButtonElement>('[data-ui-action="rescan-settings-folder"]')?.disabled).toBe(false);
    expect(settings.querySelectorAll(".settings-access-note")).toHaveLength(1);
  });

  it("preserves actionable validation, loading and retry states", () => {
    const invalid = renderSettings({ settingsError: "Choose a container folder before saving." });
    expect(invalid.querySelector(".settings-error-summary[role=alert]")?.textContent).toContain("Choose a container folder before saving.");
    const loading = renderSettings({ settingsDraft: undefined });
    expect(loading.querySelector(".library-loading-state[role=status]")?.textContent).toContain("Loading library settings");
    const failed = renderSettings({ settingsDraft: undefined, settingsError: "The server could not load your folders." });
    expect(failed.querySelector(".settings-load-error[role=alert]")?.textContent).toContain("The server could not load your folders.");
    expect(failed.querySelector('[data-ui-action="retry-settings-library"]')).not.toBeNull();
  });

  it("retains optional provider configuration and provider failure recovery", () => {
    const configured = renderSettings({ coverProviderSettings: { loadState: "ready", editing: false, busy: false } });
    expect(configured.querySelector('[data-ui-action="edit-google-books-key"]')).not.toBeNull();
    expect(configured.querySelector('[data-ui-action="edit-hardcover-token"]')).not.toBeNull();
    const editing = renderSettings({ coverProviderSettings: {
      loadState: "ready", editing: true, editingProvider: "hardcover", busy: false,
      error: "The token has expired.",
    } });
    expect(editing.querySelector<HTMLInputElement>("#settings-hardcover-token")?.type).toBe("password");
    expect(editing.querySelector('[data-ui-action="save-test-hardcover-token"]')).not.toBeNull();
    expect(editing.querySelector(".settings-provider-error[role=alert]")?.textContent).toBe("The token has expired.");
    const failed = renderSettings({ coverProviderSettings: {
      loadState: "error", editing: false, busy: false, error: "Provider settings unavailable.",
    } });
    expect(failed.querySelector('.settings-provider-card[role=status]')?.textContent).toContain("Provider settings unavailable.");
    expect(failed.querySelector('[data-ui-action="retry-cover-provider-settings"]')).not.toBeNull();
  });

  it("does not add the persistent access note to the focused onboarding form", () => {
    const settings = renderSettings({ onboarding: { step: "library" } });
    expect(settings.classList.contains("settings-onboarding")).toBe(true);
    expect(settings.querySelector(".settings-access-note")).toBeNull();
    expect(settings.querySelector(".settings-guidance")).toBeNull();
    expect(settings.querySelector(".settings-path-field small")?.textContent).toContain("read-only");
    expect(settings.querySelector('[data-ui-action="save-library-settings"]')).not.toBeNull();
  });
});
