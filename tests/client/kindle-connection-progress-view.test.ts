// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../client/src/app-error";
import { CatalogBrowser, type CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogApi } from "../../client/src/catalog-client";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { DebugLog } from "../../client/src/log";
import { initialAppState, type AppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

const DETAILS = { vendorId: 0x1949, productId: 0x9981 };
const error = new AppError("USB_SESSION_STALE", "The connection expired.");

function readyState(patch: Partial<AppState> = {}): AppState {
  return {
    ...initialAppState(), secureContext: true, webUsbAvailable: true,
    device: { kind: "ready", details: DETAILS }, selfTest: { kind: "passed", byteLength: 1037 },
    catalogInventoryState: "ready", ...patch,
  };
}

function metadataState(completed = 25, total: number | undefined = 100): AppState {
  return readyState({ postConnectStage: "inventory", catalogInventoryState: "loading", kindleIndexProgress: { phase: "metadata", completed, ...(total === undefined ? {} : { total }) } });
}

function render(state: AppState, patch: Partial<CatalogBrowserSnapshot> = {}): HTMLElement {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined, undefined);
  const snapshot = browser.snapshot;
  browser.dispose();
  const root = document.createElement("div");
  root.innerHTML = renderLibraryPrototype(state, { ...snapshot, ...patch });
  return root;
}

function mount(state: AppState) {
  const noop = () => undefined;
  const callbacks: AppViewHandlers = {
    onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
    onConnect: vi.fn(), onDisconnect: vi.fn(), onSelfTest: vi.fn(), onSendIntegrated: noop,
    onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const view = new AppView(root, state, callbacks, new DebugLog(), { autoStartCatalog: false });
  return { root, view, callbacks };
}

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("header Kindle indexing progress", () => {
  it("shows checked books, percentage, accessible progress and the Kindle photo in place of the connected box", () => {
    const root = render(metadataState());
    const indexing = root.querySelector(".library-topbar .library-device-indexing")!;
    expect(indexing).not.toBeNull();
    expect(indexing.textContent).toContain("Indexing Kindle…");
    expect(indexing.textContent).toContain("25 of 100 books checked");
    expect(indexing.textContent).toContain("25%");
    expect(indexing.textContent).not.toContain("Kindle connected");
    const photo = indexing.querySelector<HTMLImageElement>("img.library-kindle-photo")!;
    expect(photo.getAttribute("src")).toContain("kindle-device.png");
    expect(photo.alt).toBe("");
    const progress = indexing.querySelector<HTMLElement>('.progress-track[role="progressbar"]')!;
    expect(progress).not.toBeNull();
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(progress.getAttribute("aria-valuenow")).toBe("25");
    expect(progress.getAttribute("aria-label") || progress.getAttribute("aria-labelledby")).toBeTruthy();
    expect(progress.getAttribute("aria-valuetext")).toContain("25 of 100 books checked");
    const target = indexing.querySelector<HTMLButtonElement>('[data-ui-action="show-kindle"]')!;
    expect(target.type).toBe("button");
    expect(target.disabled).toBe(false);
    expect(target.getAttribute("aria-label")).toBeTruthy();
    // Keep the progress semantics outside the button's presentational subtree.
    expect(target.contains(progress)).toBe(false);
  });

  it.each<[string, Partial<AppState>, string]>([
    ["safe-write preparation", { postConnectStage: "safe-write", selfTest: { kind: "running" } }, "Preparing Kindle…"],
    ["unknown hierarchy size", { postConnectStage: "inventory", catalogInventoryState: "loading", kindleIndexProgress: { phase: "enumerating", completed: 9 } }, "Finding books…"],
    ["matching completion", { postConnectStage: "reconciliation", kindleIndexProgress: { phase: "metadata", completed: 100, total: 100 } }, "Finishing up…"],
  ])("shows indeterminate progress for %s without inventing a percentage", (_label, patch, expectedText) => {
    const root = render(readyState(patch));
    const indexing = root.querySelector(".library-device-indexing")!;
    expect(indexing).not.toBeNull();
    expect(indexing.textContent).toContain(expectedText);
    const progress = indexing.querySelector('[role="progressbar"]')!;
    expect(progress).not.toBeNull();
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(indexing.textContent).not.toMatch(/\d+%/u);
  });

  it.each(["requesting-permission", "opening", "mtp-reading"] as const)("shows connection progress during %s, not a false connected state", (kind) => {
    const device = kind === "requesting-permission" ? { kind } : { kind, details: DETAILS };
    const indexing = render(readyState({ device, selfTest: { kind: "not-run" }, catalogInventoryState: "idle" })).querySelector(".library-device-indexing");
    expect(indexing).not.toBeNull();
    expect(indexing?.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
    expect(indexing?.textContent).not.toContain("Kindle connected");
  });

  it("handles an empty Kindle without invalid or misleading percentages", () => {
    const indexing = render(metadataState(0, 0)).querySelector(".library-device-indexing")!;
    expect(indexing).not.toBeNull();
    expect(indexing.textContent).not.toMatch(/NaN|Infinity|undefined/u);
    const now = indexing.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow");
    if (now !== null && now !== undefined) {
      expect(Number(now)).toBeGreaterThanOrEqual(0);
      expect(Number(now)).toBeLessThanOrEqual(100);
    }
  });

  it("does not divide by an unknown metadata total", () => {
    const indexing = render({ ...metadataState(), kindleIndexProgress: { phase: "metadata", completed: 12 } }).querySelector(".library-device-indexing")!;
    expect(indexing).not.toBeNull();
    expect(indexing.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
    expect(indexing.textContent).not.toMatch(/\d+%|NaN|Infinity|undefined/u);
  });

  it.each([
    [NaN, 100], [Infinity, 100], [-4, 100], [50, NaN], [50, Infinity], [50, -1],
    [101, 100], [Number.MAX_VALUE, Number.MAX_VALUE],
  ])("bounds malformed progress counts %s/%s before displaying them", (completed, total) => {
    const indexing = render(metadataState(completed, total)).querySelector(".library-device-indexing")!;
    expect(indexing.textContent).not.toMatch(/NaN|Infinity|undefined|-\d/u);
    const now = indexing.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow");
    if (now !== null && now !== undefined) {
      expect(Number(now)).toBeGreaterThanOrEqual(0);
      expect(Number(now)).toBeLessThanOrEqual(100);
    }
  });

  it("does not render markup supplied in a malformed count", () => {
    const state = metadataState('<img src=x onerror="alert(1)">' as unknown as number, 100);
    const indexing = render(state).querySelector(".library-device-indexing")!;
    expect(indexing.querySelector("[onerror]")).toBeNull();
    expect(indexing.textContent).not.toContain("onerror");
    expect(indexing.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
  });

  it.each<[string, Partial<AppState>]>([
    ["disconnected", { device: { kind: "disconnected" } }],
    ["failed connection", { device: { kind: "error", details: DETAILS, error }, activeError: error }],
    ["failed inventory", { catalogInventoryState: "failed", activeError: new AppError("INVENTORY_INCOMPLETE", "The scan failed.") }],
    ["failed safety check", { postConnectStage: "safe-write", selfTest: { kind: "failed", error } }],
  ])("does not retain a stale progress indicator after %s", (_label, patch) => {
    const root = render({ ...metadataState(), ...patch });
    expect(root.querySelector(".library-device-indexing")).toBeNull();
  });

  it("returns to the simple connected control after the entire connection flow completes", () => {
    const root = render(readyState({ postConnectStage: "idle", kindleIndexProgress: { phase: "metadata", completed: 100, total: 100 } }), {
      kindleInventory: { deviceLabel: "Kindle", scannedAt: new Date().toISOString(), completeness: "complete", total: 0, items: [], truncated: false,
        matching: { status: "complete", matchedProfiles: 0, failedProfiles: 0 } },
    });
    expect(root.querySelector(".library-device-indexing")).toBeNull();
    expect(root.querySelector(".library-topbar .library-device-button strong")?.textContent).toBe("Kindle connected");
    expect(root.querySelector(".library-topbar .library-device-button small")).toBeNull();
  });

  it.each(["ready", "scanning"] as const)("does not replace the Kobo %s control with Kindle progress", (status) => {
    const root = render(metadataState(), { activeReader: "kobo", kobo: { status, supported: true, statuses: new Map(), countsByProfile: new Map() } });
    expect(root.querySelector(".library-device-indexing")).toBeNull();
    expect(root.querySelector(".library-topbar .library-device-button strong")?.textContent).toBe(status === "ready" ? "Kobo connected" : "Checking Kobo…");
  });

  it("keeps the header progress area clickable to open Kindle inventory without starting a device action", async () => {
    const { root, callbacks } = mount(metadataState());
    const target = root.querySelector<HTMLButtonElement>('.library-device-indexing [data-ui-action="show-kindle"]')!;
    expect(target).not.toBeNull();
    expect(target.disabled).toBe(false);
    target.click();
    await vi.waitFor(() => expect(root.querySelector(".kindle-library-view")).not.toBeNull());
    expect(callbacks.onConnect).not.toHaveBeenCalled();
    expect(callbacks.onSelfTest).not.toHaveBeenCalled();
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
  });

  it("updates only progress content while preserving a focused input, DOM nodes and scroll position", () => {
    const state = metadataState();
    const { root, view } = mount(state);
    const search = root.querySelector<HTMLInputElement>("#library-search")!;
    const main = root.querySelector<HTMLElement>(".library-main")!;
    const toolbar = root.querySelector(".library-toolbar")!;
    const queue = root.querySelector('[data-ui-action="open-send-queue"]')!;
    const activity = root.querySelector('[data-ui-action="open-activity-center"]')!;
    const target = root.querySelector('.library-device-indexing [data-ui-action="show-kindle"]')!;
    const photo = root.querySelector(".library-device-indexing img")!;
    search.value = "An unfinished search";
    search.focus();
    search.setSelectionRange(3, 9);
    main.scrollTop = 420;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    view.render({ ...state, kindleIndexProgress: { phase: "metadata", completed: 26, total: 100 } });

    expect(root.querySelector("#library-search")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("An unfinished search");
    expect(search.selectionStart).toBe(3);
    expect(search.selectionEnd).toBe(9);
    expect(root.querySelector(".library-main")).toBe(main);
    expect(main.scrollTop).toBe(420);
    expect(root.querySelector(".library-toolbar")).toBe(toolbar);
    expect(root.querySelector('[data-ui-action="open-send-queue"]')).toBe(queue);
    expect(root.querySelector('[data-ui-action="open-activity-center"]')).toBe(activity);
    expect(root.querySelector('.library-device-indexing [data-ui-action="show-kindle"]')).toBe(target);
    expect(root.querySelector(".library-device-indexing img")).toBe(photo);
    expect(root.querySelector(".library-device-indexing-content")?.textContent).toContain("26 of 100 books checked");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("retains focused header navigation and its click handler through repeated progress updates", async () => {
    const state = metadataState();
    const { root, view } = mount(state);
    const target = root.querySelector<HTMLButtonElement>('.library-device-indexing [data-ui-action="show-kindle"]')!;
    target.focus();
    for (const completed of [26, 27, 42, 99]) view.render({ ...state, kindleIndexProgress: { phase: "metadata", completed, total: 100 } });
    expect(document.activeElement).toBe(target);
    expect(root.querySelector('.library-device-indexing [data-ui-action="show-kindle"]')).toBe(target);
    target.click();
    await vi.waitFor(() => expect(root.querySelector(".kindle-library-view")).not.toBeNull());
  });
});
