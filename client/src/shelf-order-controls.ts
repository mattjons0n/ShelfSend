export interface ShelfOrderCallbacks {
  reorder(sourceId: string, targetId: string): Promise<void> | void;
  move(id: string, direction: -1 | 1): Promise<void> | void;
}

const LIST = "[data-shelf-order-list][data-profile-id]";
const ROW = "[data-sidebar-shelf-id]";
const HANDLE = "button[data-shelf-drag-handle]";
const MOVE = 'button[data-ui-action="move-sidebar-shelf"]';
const suppressedClicks = new WeakMap<HTMLElement, { profile: string; list: string; id: string; until: number }>();

function rows(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(ROW)].filter((row) => row.closest(LIST) === list);
}

function isBusy(list: HTMLElement): boolean {
  return list.getAttribute("aria-busy") === "true" || list.dataset.busy === "true";
}

/** Dragging is local UI intent only: never accept shelf IDs from an external drop. */
export function bindShelfOrderControls(root: HTMLElement, callbacks: ShelfOrderCallbacks): void {
  let drag: { list: HTMLElement; profile: string; row: HTMLElement; handle: HTMLButtonElement; id: string } | undefined;
  let pending = false;

  const clearMarkers = () => {
    root.querySelectorAll(".shelf-drop-before, .shelf-drop-after").forEach((row) => row.classList.remove("shelf-drop-before", "shelf-drop-after"));
  };
  const clearDrag = () => {
    drag?.row.classList.remove("shelf-dragging");
    clearMarkers();
    drag = undefined;
  };
  const liveList = (list: HTMLElement, profile: string) => root.isConnected && root.contains(list)
    && list.dataset.profileId === profile && !isBusy(list) && !pending;
  const validTarget = (list: HTMLElement, target: HTMLElement) => {
    if (!drag || drag.list !== list || !liveList(list, drag.profile) || drag.handle.disabled
      || drag.row.closest(LIST) !== list || drag.row.dataset.sidebarShelfId !== drag.id
      || target.closest(LIST) !== list || target === drag.row) return false;
    const currentRows = rows(list);
    const ids = currentRows.map((row) => row.dataset.sidebarShelfId);
    return currentRows.includes(drag.row) && currentRows.includes(target) && ids.every(Boolean)
      && new Set(ids).size === ids.length && !target.querySelector<HTMLButtonElement>(HANDLE)?.disabled;
  };
  const invoke = (action: () => Promise<void> | void, finish: () => void = () => undefined) => {
    pending = true;
    const done = () => { pending = false; finish(); };
    // The application callback owns error presentation; release interaction state on either outcome.
    try { void Promise.resolve(action()).then(done, done); }
    catch { done(); }
  };

  root.querySelectorAll<HTMLElement>(LIST).forEach((list) => {
    const profile = list.dataset.profileId!;
    list.addEventListener("dragstart", (event) => {
      const handle = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(HANDLE) : null;
      const row = handle?.closest<HTMLElement>(ROW);
      if (!handle || !row || row.closest(LIST) !== list || handle.disabled || !handle.draggable
        || !row.dataset.sidebarShelfId || !liveList(list, profile)) {
        event.preventDefault();
        clearDrag();
        return;
      }
      clearDrag();
      drag = { list, profile, row, handle, id: row.dataset.sidebarShelfId };
      row.classList.add("shelf-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", drag.id);
      }
    });
    list.addEventListener("dragover", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(ROW) : null;
      clearMarkers();
      if (!target || !validTarget(list, target)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const currentRows = rows(list);
      target.classList.add(currentRows.indexOf(drag!.row) < currentRows.indexOf(target) ? "shelf-drop-after" : "shelf-drop-before");
    });
    list.addEventListener("dragleave", (event) => {
      if (!(event.relatedTarget instanceof Node) || !list.contains(event.relatedTarget)) clearMarkers();
    });
    list.addEventListener("drop", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(ROW) : null;
      const current = drag;
      const accepted = target && validTarget(list, target);
      clearDrag();
      if (!accepted || !current || !target) return;
      event.preventDefault();
      suppressedClicks.set(root, { profile, list: list.dataset.shelfOrderList ?? "", id: current.id, until: Date.now() + 400 });
      invoke(() => callbacks.reorder(current.id, target.dataset.sidebarShelfId!));
    });
    list.addEventListener("dragend", clearDrag);
    list.querySelectorAll<HTMLButtonElement>(HANDLE).forEach((handle) => {
      handle.addEventListener("click", (event) => {
        const suppressed = suppressedClicks.get(root);
        if (suppressed && suppressed.until >= Date.now() && suppressed.profile === profile
          && suppressed.list === (list.dataset.shelfOrderList ?? "")
          && suppressed.id === handle.closest<HTMLElement>(ROW)?.dataset.sidebarShelfId) {
          suppressedClicks.delete(root);
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, { capture: true });
    });
    list.querySelectorAll<HTMLButtonElement>(MOVE).forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.shelfId;
        const direction = button.dataset.direction === "-1" ? -1 : button.dataset.direction === "1" ? 1 : undefined;
        const row = button.closest<HTMLElement>(ROW);
        if (!id || direction === undefined || button.disabled || !row || row.closest(LIST) !== list
          || row.dataset.sidebarShelfId !== id || !liveList(list, profile)) return;
        const currentRows = rows(list);
        const nextIndex = currentRows.indexOf(row) + direction;
        if (nextIndex < 0 || nextIndex >= currentRows.length) return;

        const heldFocus = document.activeElement === button;
        let focusMoved = false;
        const observeFocus = (event: FocusEvent) => { if (event.target !== button) focusMoved = true; };
        if (heldFocus) document.addEventListener("focusin", observeFocus, true);
        const finish = () => {
          document.removeEventListener("focusin", observeFocus, true);
          if (!heldFocus || focusMoved || !root.isConnected) return;
          // Full render may replace the focused button. Restore only in this same profile/list.
          const nextList = [...root.querySelectorAll<HTMLElement>(LIST)].find((candidate) => candidate.dataset.profileId === profile
            && candidate.dataset.shelfOrderList === list.dataset.shelfOrderList);
          if (!nextList || isBusy(nextList)) return;
          const nextRow = rows(nextList).find((candidate) => candidate.dataset.sidebarShelfId === id);
          const buttons = [...(nextRow?.querySelectorAll<HTMLButtonElement>(MOVE) ?? [])].filter((candidate) => !candidate.disabled);
          const nextButton = buttons.find((candidate) => candidate.dataset.direction === String(direction)) ?? buttons[0];
          nextButton?.focus({ preventScroll: true });
        };
        invoke(() => callbacks.move(id, direction), finish);
      });
    });
  });
}
