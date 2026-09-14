import { isLibraryCardSize } from "./library-display-preferences";

function previewCardSize(root: ParentNode, value: number): void {
  if (!isLibraryCardSize(value)) return;
  root.querySelector<HTMLElement>('.library-book-grid[data-layout="grid"]')
    ?.style.setProperty("--library-card-min-width", `${value}px`);
}

/** Preview directly while dragging; only commit on change so the slider is
 * not replaced (and its pointer gesture lost) on every input event. */
export function bindLibraryDisplayControls(root: ParentNode, actions: {
  readonly setCardSize: (size: number) => void;
  readonly setPageSize: (size: number) => void;
}): void {
  const slider = root.querySelector<HTMLInputElement>("#library-card-size");
  slider?.addEventListener("input", () => {
    if (!slider.disabled) {
      slider.dataset.previewPending = "true";
      previewCardSize(root, Number(slider.value));
    }
  });
  slider?.addEventListener("change", () => {
    if (!slider.disabled) {
      delete slider.dataset.previewPending;
      actions.setCardSize(Number(slider.value));
    }
  });
  const pageSize = root.querySelector<HTMLSelectElement>("#library-page-size");
  pageSize?.addEventListener("change", () => {
    if (!pageSize.disabled) actions.setPageSize(Number(pageSize.value));
  });
}

/** Keep keyboard focus and an uncommitted slider preview through catalog or
 * status refreshes without scrolling the dashboard back to the control. */
export function captureLibraryDisplayControl(root: HTMLElement): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)
    || !["library-card-size", "library-page-size"].includes(active.id)) return () => undefined;
  const id = active.id;
  const preview = active instanceof HTMLInputElement && active.dataset.previewPending === "true"
    ? Number(active.value) : undefined;
  return () => {
    const replacement = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (!replacement || replacement.disabled) return;
    if (preview !== undefined && isLibraryCardSize(preview)) {
      replacement.value = String(preview);
      replacement.dataset.previewPending = "true";
      previewCardSize(root, preview);
    }
    replacement.focus({ preventScroll: true });
  };
}
