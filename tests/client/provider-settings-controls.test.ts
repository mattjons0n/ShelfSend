// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot, type CatalogCoverProviderSettingsState } from "../../client/src/catalog-browser";
import type { CatalogApi } from "../../client/src/catalog-client";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { bindSettingsProviderDisclosure, captureSettingsProviderDisclosure } from "../../client/src/provider-settings-controls";
import { initialAppState } from "../../client/src/state";

const PROVIDERS = ["google-books", "hardcover"] as const;
type Provider = typeof PROVIDERS[number];
const BASE_SETTINGS: CatalogCoverProviderSettingsState = {
  loadState: "ready", busy: false, editing: false,
  googleBooks: { provider: "google-books", configured: false, maskedKey: null, revision: 0, status: "not-configured", lastTestedAt: null, errorCode: null },
  hardcover: { provider: "hardcover", configured: true, maskedKey: "••••••••", revision: 1, status: "working", lastTestedAt: null, errorCode: null },
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function snapshot(settings: Partial<CatalogCoverProviderSettingsState> = {}, locked = false): CatalogBrowserSnapshot {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined);
  const initial = browser.snapshot;
  browser.dispose();
  return {
    ...initial,
    loadState: "ready",
    filters: { ...initial.filters, view: "settings" },
    serviceStatus: { available: true, state: "ready", settingsMode: locked ? "read-only" : "read-write", database: "ready", cache: "ready" },
    coverProviderSettings: { ...BASE_SETTINGS, ...settings },
  };
}

function renderInto(root: HTMLElement, settings: Partial<CatalogCoverProviderSettingsState> = {}, locked = false) {
  root.innerHTML = renderLibraryPrototype(initialAppState(), snapshot(settings, locked));
  bindSettingsProviderDisclosure(root);
}

function fixture(settings: Partial<CatalogCoverProviderSettingsState> = {}, locked = false) {
  const root = document.createElement("div");
  document.body.append(root);
  renderInto(root, settings, locked);
  return root;
}

function controls(root: HTMLElement, provider: Provider) {
  const card = root.querySelector<HTMLElement>(`.settings-provider-card[data-provider="${provider}"]`)!;
  const button = card.querySelector<HTMLButtonElement>('[data-ui-action="toggle-provider-settings"]')!;
  const body = card.querySelector<HTMLElement>(".settings-provider-body")!;
  return { card, button, body };
}

describe("explicit provider Configure controls", () => {
  it.each(PROVIDERS)("renders %s as a passive frame with a native Configure button", (provider) => {
    const { card, button, body } = controls(fixture(), provider);
    expect(card.tagName).toBe("SECTION");
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(card.getAttribute("role")).not.toBe("button");
    expect(card.querySelector("summary")).toBeNull();
    expect(button.type).toBe("button");
    expect(button.textContent?.trim()).toBe("Configure");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(body.id);
    expect(body.hidden).toBe(true);
  });

  it.each(PROVIDERS)("ignores clicks on the %s frame, title, subtitle and status", (provider) => {
    const { card, button, body } = controls(fixture(), provider);
    for (const target of [card, card.querySelector(".settings-provider-head")!, card.querySelector("strong")!, card.querySelector("small")!, card.querySelector(".settings-provider-status")!]) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(body.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("opens each provider independently, with no credential action or network request", () => {
    const root = fixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    const credentialAction = vi.fn();
    root.querySelectorAll<HTMLButtonElement>(".settings-provider-actions button").forEach((button) => button.addEventListener("click", credentialAction));
    const google = controls(root, "google-books");
    const hardcover = controls(root, "hardcover");
    google.button.click();
    expect(google.body.hidden).toBe(false);
    expect(google.button.getAttribute("aria-expanded")).toBe("true");
    expect(hardcover.body.hidden).toBe(true);
    hardcover.button.focus();
    hardcover.button.click(); // Native keyboard activation also dispatches this click.
    expect(document.activeElement).toBe(hardcover.button);
    expect(hardcover.body.hidden).toBe(false);
    expect(hardcover.button.getAttribute("aria-expanded")).toBe("true");
    expect(google.body.hidden).toBe(false);
    google.button.click();
    expect(google.body.hidden).toBe(true);
    expect(google.button.getAttribute("aria-expanded")).toBe("false");
    expect(hardcover.body.hidden).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialAction).not.toHaveBeenCalled();
  });

  it("retains visible status and Add, Replace and Remove credential actions", () => {
    const root = fixture();
    const google = controls(root, "google-books");
    const hardcover = controls(root, "hardcover");
    expect(google.card.querySelector(".settings-provider-status")?.textContent).toContain("Not configured");
    expect(hardcover.card.querySelector(".settings-provider-status")?.textContent).toContain("Working");
    expect(google.card.querySelector('[data-ui-action="edit-google-books-key"]')?.textContent).toBe("Add key");
    expect(hardcover.card.querySelector('[data-ui-action="edit-hardcover-token"]')?.textContent).toBe("Replace token");
    expect(hardcover.card.querySelector('[data-ui-action="remove-hardcover-token"]')?.textContent).toBe("Remove");
  });

  it.each(PROVIDERS)("keeps %s editing expanded with password, Cancel and Save & test", (provider) => {
    const root = fixture({ editing: true, editingProvider: provider });
    const { button, body } = controls(root, provider);
    const action = provider === "hardcover" ? "hardcover-token" : "google-books-key";
    expect(body.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(body.querySelector<HTMLInputElement>(`#settings-${action}`)?.type).toBe("password");
    expect(body.querySelector<HTMLInputElement>(`#settings-${action}`)?.value).toBe("");
    expect(body.querySelector(`[data-ui-action="cancel-${action}"]`)?.textContent).toBe("Cancel");
    expect(body.querySelector(`[data-ui-action="save-test-${action}"]`)?.textContent).toBe("Save & test");
  });

  it("keeps saving credential controls disabled and never exposes the configured secret", () => {
    const { card, button, body } = controls(fixture({ busy: true, editing: true, editingProvider: "hardcover" }), "hardcover");
    expect(body.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    button.click();
    expect(body.hidden).toBe(false);
    expect(body.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    for (const button of body.querySelectorAll<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
    expect(card.textContent).toContain("Saving and testing…");
    expect(body.querySelector<HTMLInputElement>("input")?.value).toBe("");
  });

  it("retains locked-provider guidance without credential editing actions", () => {
    const root = fixture({}, true);
    for (const provider of PROVIDERS) {
      const { button, body } = controls(root, provider);
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("locked");
      button.click();
      expect(body.hidden).toBe(true);
      expect(body.textContent).toContain("locked Settings");
      expect(body.querySelector("input, .settings-provider-actions")).toBeNull();
    }
  });
});

describe("provider disclosure across DOM refreshes", () => {
  it("restores only previously expanded panels and the focused Configure button", () => {
    const root = fixture();
    const old = controls(root, "hardcover");
    old.button.click();
    old.button.focus();
    const restore = captureSettingsProviderDisclosure(root);
    renderInto(root);
    restore();
    const next = controls(root, "hardcover");
    expect(next.button).not.toBe(old.button);
    expect(next.body.hidden).toBe(false);
    expect(next.button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(next.button);
    expect(controls(root, "google-books").body.hidden).toBe(true);
    next.button.click();
    expect(next.body.hidden).toBe(true);
  });

  it("does not collapse a newly opened credential editor during a render", () => {
    const root = fixture();
    const restore = captureSettingsProviderDisclosure(root);
    renderInto(root, { editing: true, editingProvider: "hardcover" });
    restore();
    expect(controls(root, "hardcover").body.hidden).toBe(false);
    expect(controls(root, "hardcover").button.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not steal focus from outside provider cards or resurrect removed Settings content", () => {
    const root = fixture();
    controls(root, "hardcover").button.click();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const restore = captureSettingsProviderDisclosure(root);
    renderInto(root);
    restore();
    expect(document.activeElement).toBe(outside);
    const leaveSettings = captureSettingsProviderDisclosure(root);
    root.replaceChildren();
    expect(() => leaveSettings()).not.toThrow();
    expect(root.children).toHaveLength(0);
  });
});
