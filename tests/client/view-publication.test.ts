// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogKindleInventory } from "../../client/src/catalog-browser";
import { DebugLog } from "../../client/src/log";
import { initialAppState, type AppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

const READY: AppState = {
  ...initialAppState(), secureContext: true, webUsbAvailable: true,
  device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
  selfTest: { kind: "passed", byteLength: 1037 }, catalogInventoryState: "ready",
};
const INVENTORY: CatalogKindleInventory = {
  deviceLabel: "Kindle", scannedAt: "2026-09-14T10:00:00Z", completeness: "complete", total: 2,
  truncated: false, matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
  items: [1, 2].map((id) => ({
    id: `device-${id}`, filename: `copy-${id}.azw3`, title: "One book", format: "AZW3", size: 512,
    managed: true, bookId: "book-1", match: "confirmed",
  })),
};

function mount(state: AppState = READY) {
  const noop = () => undefined;
  const handlers: AppViewHandlers = {
    onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
    onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop,
    onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const view = new AppView(root, state, handlers, new DebugLog(), { autoStartCatalog: false });
  const observer = new MutationObserver(noop);
  observer.observe(root, { childList: true });
  return { root, view, observer };
}

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("synchronous comparison publication", () => {
  it("publishes statuses, duplicate inventory and readiness in one root replacement", () => {
    const { root, view, observer } = mount({ ...READY, catalogInventoryState: "loading", postConnectStage: "reconciliation" });
    const original = root.firstElementChild;
    view.batchUpdates(() => {
      view.setCatalogKindleStatuses(new Map([["book-1", "confirmed"]]));
      view.setCatalogKindleInventory(INVENTORY);
      view.render(READY);
      expect(view.catalogKindleStatus("book-1")).toBe("confirmed");
      expect(root.firstElementChild).toBe(original);
      expect(observer.takeRecords()).toHaveLength(0);
    });
    expect(observer.takeRecords()).toHaveLength(1);
    expect(root.firstElementChild).not.toBe(original);
    expect(root.querySelector(".library-device-indexing")).toBeNull();
    expect(root.querySelector(".library-topbar")?.textContent).toContain("Kindle connected");
    expect(root.querySelector('[data-ui-view="on-kindle"]')?.textContent).toContain("2");
    observer.disconnect();
  });

  it("still publishes changed catalog data when the AppState object is unchanged", () => {
    const { root, view, observer } = mount();
    view.batchUpdates(() => {
      view.setCatalogKindleInventory(INVENTORY);
      view.render(READY);
    });
    expect(observer.takeRecords()).toHaveLength(1);
    expect(root.querySelector('[data-ui-view="on-kindle"]')?.textContent).toContain("2");
    observer.disconnect();
  });

  it("flushes a nested throwing publication and does not leave future renders suspended", () => {
    const { root, view, observer } = mount();
    const error = new Error("publication failed");
    expect(() => view.batchUpdates(() => {
      view.setCatalogKindleInventory(INVENTORY);
      view.batchUpdates(() => {
        view.render({ ...READY, device: { kind: "disconnected" } });
        throw error;
      });
    })).toThrow(error);
    expect(observer.takeRecords()).toHaveLength(1);
    expect(root.querySelector('[data-ui-action="toggle-reader-picker"]')).not.toBeNull();
    view.render(READY);
    expect(observer.takeRecords()).toHaveLength(1);
    expect(root.querySelector(".library-topbar")?.textContent).toContain("Kindle connected");
    observer.disconnect();
  });
});
