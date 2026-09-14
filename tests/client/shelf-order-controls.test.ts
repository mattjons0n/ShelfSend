// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindShelfOrderControls } from "../../client/src/shelf-order-controls";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function markup(ids = ["recent", "favorites", "missing"], profile = "alice", kind = "manager") {
  return `<div data-shelf-order-list="${kind}" data-profile-id="${profile}" aria-busy="false">${ids.map((id, index) => `
    <div data-sidebar-shelf-id="${id}"><span>${id}</span>
      <button type="button" data-shelf-drag-handle draggable="true">Drag</button>
      <button type="button" data-ui-action="move-sidebar-shelf" data-shelf-id="${id}" data-direction="-1" ${index === 0 ? "disabled" : ""}>Up</button>
      <button type="button" data-ui-action="move-sidebar-shelf" data-shelf-id="${id}" data-direction="1" ${index === ids.length - 1 ? "disabled" : ""}>Down</button>
    </div>`).join("")}</div>`;
}
function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  root.innerHTML = markup();
  const callbacks = { reorder: vi.fn<(...args: [string, string]) => Promise<void> | void>(), move: vi.fn<(...args: [string, -1 | 1]) => Promise<void> | void>() };
  bindShelfOrderControls(root, callbacks);
  return { root, callbacks, list: root.firstElementChild as HTMLElement };
}
function row(root: ParentNode, id: string) { return root.querySelector<HTMLElement>(`[data-sidebar-shelf-id="${id}"]`)!; }
function handle(root: ParentNode, id: string) { return row(root, id).querySelector<HTMLButtonElement>("[data-shelf-drag-handle]")!; }
function arrow(root: ParentNode, id: string, direction: -1 | 1) { return row(root, id).querySelector<HTMLButtonElement>(`[data-direction="${direction}"]`)!; }
function drag(target: HTMLElement, type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn(() => "injected") };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return { event, dataTransfer };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

describe("shelf drag ordering", () => {
  it("uses only internal source identity and shows directional insertion markers", async () => {
    const { root, callbacks } = setup();
    drag(handle(root, "recent"), "dragstart");
    expect(row(root, "recent").classList.contains("shelf-dragging")).toBe(true);
    const over = drag(row(root, "missing"), "dragover");
    expect(over.event.defaultPrevented).toBe(true);
    expect(row(root, "missing").classList.contains("shelf-drop-after")).toBe(true);
    const drop = drag(row(root, "missing"), "drop");
    expect(drop.event.defaultPrevented).toBe(true);
    expect(drop.dataTransfer.getData).not.toHaveBeenCalled();
    expect(callbacks.reorder).toHaveBeenCalledExactlyOnceWith("recent", "missing");
    expect(root.querySelector(".shelf-dragging, .shelf-drop-after")).toBeNull();
    await settle();
    drag(handle(root, "missing"), "dragstart");
    drag(row(root, "recent"), "dragover");
    expect(row(root, "recent").classList.contains("shelf-drop-before")).toBe(true);
    drag(handle(root, "missing"), "dragend");
    expect(root.querySelector(".shelf-dragging, .shelf-drop-before")).toBeNull();
  });

  it("ignores externally supplied shelf IDs and same-row drops", () => {
    const { root, callbacks } = setup();
    expect(drag(row(root, "favorites"), "dragover").event.defaultPrevented).toBe(false);
    drag(row(root, "favorites"), "drop");
    drag(handle(root, "favorites"), "dragstart");
    drag(row(root, "favorites"), "drop");
    expect(callbacks.reorder).not.toHaveBeenCalled();
  });

  it.each(["busy", "disabled", "removed", "profile", "source-removed"])("rejects a %s drag session at drop time", (change) => {
    const { root, list, callbacks } = setup();
    const target = row(root, "missing");
    drag(handle(root, "recent"), "dragstart");
    if (change === "busy") list.setAttribute("aria-busy", "true");
    if (change === "disabled") handle(root, "recent").disabled = true;
    if (change === "removed") list.remove();
    if (change === "profile") list.dataset.profileId = "bob";
    if (change === "source-removed") row(root, "recent").remove();
    drag(target, "drop");
    expect(callbacks.reorder).not.toHaveBeenCalled();
  });

  it("cannot begin from the entire row, a disabled handle, or while busy", () => {
    const { root, list, callbacks } = setup();
    expect(drag(row(root, "recent"), "dragstart").event.defaultPrevented).toBe(true);
    handle(root, "recent").disabled = true;
    expect(drag(handle(root, "recent"), "dragstart").event.defaultPrevented).toBe(true);
    handle(root, "recent").disabled = false;
    list.setAttribute("aria-busy", "true");
    drag(handle(root, "recent"), "dragstart");
    drag(row(root, "missing"), "drop");
    expect(callbacks.reorder).not.toHaveBeenCalled();
  });

  it("rejects drops into a different list even for the same profile", () => {
    const { root, callbacks } = setup();
    root.innerHTML += markup(undefined, "alice", "sidebar");
    bindShelfOrderControls(root, callbacks);
    const lists = root.querySelectorAll<HTMLElement>("[data-shelf-order-list]");
    drag(handle(lists[0], "recent"), "dragstart");
    drag(row(lists[1], "missing"), "drop");
    expect(callbacks.reorder).not.toHaveBeenCalled();
  });

  it("preserves ordinary handle clicks but suppresses a post-drop click", () => {
    const { root } = setup();
    const click = vi.fn();
    const source = handle(root, "recent");
    source.addEventListener("click", click);
    source.click();
    expect(click).toHaveBeenCalledTimes(1);
    drag(source, "dragstart");
    drag(row(root, "missing"), "drop");
    source.click();
    expect(click).toHaveBeenCalledTimes(1);
    source.click();
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("suppresses a generated handle click even when the completed reorder rerendered the list", () => {
    const { root, callbacks } = setup();
    callbacks.reorder.mockImplementation(() => {
      root.innerHTML = markup(["favorites", "missing", "recent"]);
      bindShelfOrderControls(root, callbacks);
    });
    drag(handle(root, "recent"), "dragstart");
    drag(row(root, "missing"), "drop");
    const click = vi.fn();
    handle(root, "recent").addEventListener("click", click);
    handle(root, "recent").click();
    expect(click).not.toHaveBeenCalled();
  });
});

describe("keyboard-accessible shelf move buttons", () => {
  it("accepts only valid directions and blocks boundaries, disabled and busy controls", async () => {
    const { root, list, callbacks } = setup();
    arrow(root, "recent", -1).click();
    arrow(root, "missing", 1).click();
    const up = arrow(root, "favorites", -1);
    up.dataset.direction = "2";
    up.click();
    expect(callbacks.move).not.toHaveBeenCalled();
    up.dataset.direction = "-1";
    up.click();
    expect(callbacks.move).toHaveBeenCalledExactlyOnceWith("favorites", -1);
    await settle();
    list.setAttribute("aria-busy", "true");
    arrow(root, "recent", 1).click();
    expect(callbacks.move).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate actions pending completion and releases after an error", async () => {
    const { root, callbacks } = setup();
    let reject!: (error: Error) => void;
    callbacks.move.mockImplementationOnce(() => new Promise<void>((_, rejectPromise) => { reject = rejectPromise; }));
    arrow(root, "favorites", -1).click();
    arrow(root, "favorites", 1).click();
    expect(callbacks.move).toHaveBeenCalledTimes(1);
    reject(new Error("save failed"));
    await settle();
    arrow(root, "favorites", 1).click();
    expect(callbacks.move).toHaveBeenCalledTimes(2);
  });

  it("restores focus without scrolling after render, using the opposite button at a boundary", async () => {
    const { root, callbacks } = setup();
    const old = arrow(root, "favorites", -1);
    old.focus();
    callbacks.move.mockImplementation(() => {
      root.innerHTML = markup(["favorites", "recent", "missing"]);
      bindShelfOrderControls(root, callbacks);
    });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    old.click();
    await settle();
    expect(document.activeElement).toBe(arrow(root, "favorites", 1));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("restores focus in the manager rather than another shelf list for the same profile", async () => {
    const { root, callbacks } = setup();
    arrow(root, "favorites", -1).focus();
    callbacks.move.mockImplementation(() => {
      root.innerHTML = markup(undefined, "alice", "sidebar") + markup(["favorites", "recent", "missing"]);
      bindShelfOrderControls(root, callbacks);
    });
    arrow(root, "favorites", -1).click();
    await settle();
    expect(document.activeElement).toBe(arrow(root.querySelector('[data-shelf-order-list="manager"]')!, "favorites", 1));
  });

  it.each(["other-control", "other-profile", "closed", "never-focused"])("does not steal focus when %s", async (change) => {
    const { root, callbacks } = setup();
    let resolve!: () => void;
    const outside = document.createElement("button");
    document.body.append(outside);
    const old = arrow(root, "favorites", -1);
    if (change !== "never-focused") old.focus();
    else outside.focus();
    callbacks.move.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    old.click();
    if (change === "other-control") outside.focus();
    root.innerHTML = change === "closed" ? "" : markup(["favorites", "recent", "missing"], change === "other-profile" ? "bob" : "alice");
    const focusBefore = document.activeElement;
    resolve();
    await settle();
    expect(document.activeElement).toBe(focusBefore);
  });
});
