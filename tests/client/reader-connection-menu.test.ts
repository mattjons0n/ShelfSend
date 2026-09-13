// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindReaderConnectionMenu } from "../../client/src/reader-connection-menu";
import { CatalogBrowser, type CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogApi } from "../../client/src/catalog-client";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { initialAppState, type AppState } from "../../client/src/state";
import { AppView } from "../../client/src/view";
import { DebugLog } from "../../client/src/log";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function menu(disabledKobo = false) {
  const root = document.createElement("div");
  root.innerHTML = `<div class="library-reader-picker"><button type="button" data-ui-action="toggle-reader-picker" aria-expanded="false" aria-controls="reader-connection-options">Connect eReader</button><div class="library-reader-options" id="reader-connection-options" hidden role="group" aria-label="Choose an eReader"><button type="button" data-ui-action="connect-catalog-device"><span>Kindle</span></button><button type="button" data-ui-action="connect-kobo"${disabledKobo ? ' disabled title="Use desktop Chrome or Edge for Kobo"' : ""}><span>Kobo</span></button></div></div><button type="button" id="outside">Outside</button>`;
  document.body.append(root);
  const trigger = root.querySelector<HTMLButtonElement>('[data-ui-action="toggle-reader-picker"]')!;
  const options = root.querySelector<HTMLElement>(".library-reader-options")!;
  const kindle = root.querySelector<HTMLButtonElement>('[data-ui-action="connect-catalog-device"]')!;
  const kobo = root.querySelector<HTMLButtonElement>('[data-ui-action="connect-kobo"]')!;
  const outside = root.querySelector<HTMLButtonElement>("#outside")!;
  const unbind = bindReaderConnectionMenu(root);
  cleanups.push(unbind);
  return { root, trigger, options, kindle, kobo, outside, unbind };
}

function key(target: HTMLElement, name: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

describe("reader connection dropdown", () => {
  it("starts closed and toggles without initiating either connection", () => {
    const { trigger, options, kindle, kobo } = menu();
    const kindleConnect = vi.fn();
    const koboConnect = vi.fn();
    kindle.addEventListener("click", kindleConnect);
    kobo.addEventListener("click", koboConnect);
    expect(options.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    expect(options.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    expect(options.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(kindleConnect).not.toHaveBeenCalled();
    expect(koboConnect).not.toHaveBeenCalled();
  });

  it.each(["kindle", "kobo"] as const)("selecting %s closes first and preserves the synchronous connection gesture", (choice) => {
    const controls = menu();
    const chosen = vi.fn(() => {
      // A native USB/folder picker must still run in this exact click stack.
      expect(controls.options.hidden).toBe(true);
      expect(controls.trigger.getAttribute("aria-expanded")).toBe("false");
    });
    const other = vi.fn();
    controls[choice].addEventListener("click", chosen);
    controls[choice === "kindle" ? "kobo" : "kindle"].addEventListener("click", other);
    controls.trigger.click();
    controls[choice].querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(chosen).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("Escape dismisses the menu and returns keyboard focus to its trigger", () => {
    const { trigger, options, kobo } = menu();
    trigger.click();
    kobo.focus();
    key(kobo, "Escape");
    expect(options.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses on outside click without stealing outside focus", () => {
    const { trigger, options, outside } = menu();
    trigger.click();
    outside.click();
    expect(options.hidden).toBe(true);
    trigger.click();
    outside.focus();
    expect(options.hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("keeps disabled providers unavailable without closing or invoking them", () => {
    const { trigger, options, kobo } = menu(true);
    const connect = vi.fn();
    kobo.addEventListener("click", connect);
    trigger.click();
    kobo.click();
    expect(kobo.disabled).toBe(true);
    expect(kobo.title).toContain("Chrome");
    expect(connect).not.toHaveBeenCalled();
    expect(options.hidden).toBe(false);
  });

  it("navigates enabled options with arrows and skips unavailable providers", () => {
    const { trigger, kindle, kobo, options } = menu();
    trigger.focus();
    key(trigger, "ArrowDown");
    expect(options.hidden).toBe(false);
    expect(document.activeElement).toBe(kindle);
    key(kindle, "ArrowDown");
    expect(document.activeElement).toBe(kobo);
    key(kobo, "ArrowUp");
    expect(document.activeElement).toBe(kindle);
    kobo.disabled = true;
    key(kindle, "ArrowDown");
    expect(document.activeElement).toBe(kindle);
  });

  it("removes menu listeners on cleanup so later renders do not accumulate handlers", () => {
    const { trigger, options, outside, unbind } = menu();
    unbind();
    trigger.click();
    expect(options.hidden).toBe(true);
    options.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    outside.click();
    expect(options.hidden).toBe(false);
    outside.focus();
    expect(options.hidden).toBe(false);
  });
});

function header(statePatch: Partial<AppState> = {}, snapshotPatch: Partial<CatalogBrowserSnapshot> = {}) {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined);
  cleanups.push(() => browser.dispose());
  const snapshot: CatalogBrowserSnapshot = {
    ...browser.snapshot,
    activeReader: "kindle",
    kobo: { status: "disconnected", supported: true, statuses: new Map(), countsByProfile: new Map() },
    ...snapshotPatch,
  };
  const container = document.createElement("div");
  container.innerHTML = renderLibraryPrototype({ ...initialAppState(), secureContext: true, webUsbAvailable: true, ...statePatch }, snapshot);
  return container.querySelector<HTMLElement>(".library-topbar")!;
}

describe("connection chooser rendering", () => {
  it("replaces the two disconnected header buttons with one accessible chooser", () => {
    const rendered = header();
    const trigger = rendered.querySelector<HTMLButtonElement>('[data-ui-action="toggle-reader-picker"]');
    expect(trigger?.textContent).toContain("Connect eReader");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    const options = rendered.querySelector<HTMLElement>(".library-reader-options")!;
    expect(options.hidden).toBe(true);
    expect(options.id).toBe(trigger?.getAttribute("aria-controls"));
    expect(options.getAttribute("role")).toBe("group");
    expect(options.getAttribute("aria-label")).toBe("Choose an eReader");
    expect(options.querySelector('[data-ui-action="connect-catalog-device"]')?.textContent).toContain("Kindle");
    expect(options.querySelector('[data-ui-action="connect-kobo"]')?.textContent).toContain("Kobo");
    expect(rendered.querySelectorAll('[data-ui-action="toggle-reader-picker"]')).toHaveLength(1);
  });

  it("keeps unsupported connections disabled with an explanation", () => {
    const rendered = header({ secureContext: false, webUsbAvailable: false }, {
      kobo: { status: "disconnected", supported: false, statuses: new Map(), countsByProfile: new Map() },
    });
    for (const action of ["connect-catalog-device", "connect-kobo"]) {
      const option = rendered.querySelector<HTMLButtonElement>(`[data-ui-action="${action}"]`)!;
      expect(option.disabled).toBe(true);
      expect(option.title || option.getAttribute("aria-describedby") || option.textContent).toMatch(/HTTPS|browser|Chrome|Edge|secure|supported/i);
    }
  });

  it.each(["ready", "requesting-permission", "opening", "mtp-reading", "recovering"] as const)("shows only Kindle status while its session is %s", (kind) => {
    const rendered = header({ device: kind === "requesting-permission" ? { kind } : { kind, details: { vendorId: 0x1949, productId: 0x9981 } } });
    expect(rendered.querySelector(".library-reader-picker")).toBeNull();
    expect(rendered.querySelector('[data-ui-action="connect-kobo"]')).toBeNull();
    expect(rendered.textContent).toMatch(/Kindle|Disconnecting/);
  });

  it.each(["ready", "connecting", "scanning"] as const)("shows only Kobo status while its session is %s", (status) => {
    const rendered = header({}, { activeReader: "kobo", kobo: { status, supported: true, statuses: new Map(), countsByProfile: new Map() } });
    expect(rendered.querySelector(".library-reader-picker")).toBeNull();
    expect(rendered.querySelector('[data-ui-action="connect-catalog-device"]')).toBeNull();
    expect(rendered.textContent).toContain("Kobo");
  });
});

describe("connection chooser across AppView refreshes", () => {
  it("preserves an open chooser and focused option across a background render without connecting", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const connectKindle = vi.fn();
    const connectKobo = vi.fn();
    const noop = () => undefined;
    const state = { ...initialAppState(), secureContext: true, webUsbAvailable: true };
    const view = new AppView(root, state, {
      onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
      onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop,
      onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
      onCatalogConnectRequested: connectKindle, onKoboConnect: connectKobo,
    }, new DebugLog(), { autoStartCatalog: false, catalogApi: {} as CatalogApi });
    view.setKoboState({ status: "disconnected", supported: true, statuses: new Map(), countsByProfile: new Map() });
    root.querySelector<HTMLButtonElement>('[data-ui-action="toggle-reader-picker"]')!.click();
    const previousOption = root.querySelector<HTMLButtonElement>('[data-ui-action="connect-kobo"]')!;
    previousOption.focus();

    view.render(state);
    const nextOption = root.querySelector<HTMLButtonElement>('[data-ui-action="connect-kobo"]')!;
    expect(nextOption).not.toBe(previousOption);
    expect(root.querySelector<HTMLElement>(".library-reader-options")?.hidden).toBe(false);
    expect(root.querySelector('[data-ui-action="toggle-reader-picker"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(nextOption);
    expect(connectKindle).not.toHaveBeenCalled();
    expect(connectKobo).not.toHaveBeenCalled();

    // A real session transition must retire the disclosure, not resurrect its
    // options over the connected/connecting status in a later background render.
    view.render({ ...state, device: { kind: "requesting-permission" } });
    expect(root.querySelector(".library-reader-picker")).toBeNull();
    expect(root.querySelector(".library-reader-options")).toBeNull();
    view.render(state);
    expect(root.querySelector<HTMLElement>(".library-reader-options")?.hidden).toBe(true);
    expect(root.querySelector('[data-ui-action="toggle-reader-picker"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(connectKindle).not.toHaveBeenCalled();
    expect(connectKobo).not.toHaveBeenCalled();

    // Retire the last binding; AppView has no public dispose method.
    view.render({ ...state, device: { kind: "requesting-permission" } });
  });
});
