/** A disclosure only: the existing buttons retain their direct, user-initiated
 * connection handlers. No asynchronous work or permission requests happen here. */
export function bindReaderConnectionMenu(root: HTMLElement): () => void {
  const picker = root.querySelector<HTMLElement>(".library-reader-picker");
  const trigger = picker?.querySelector<HTMLButtonElement>('[data-ui-action="toggle-reader-picker"]');
  const options = picker?.querySelector<HTMLElement>(".library-reader-options");
  if (!picker || !trigger || !options) return () => undefined;
  const doc = root.ownerDocument;
  const enabledOptions = () => [...options.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  let listening = false;

  function dismiss(restoreFocus = false): void {
    options!.hidden = true;
    trigger!.setAttribute("aria-expanded", "false");
    if (listening) {
      doc.removeEventListener("click", onDocumentClick, true);
      doc.removeEventListener("focusin", onDocumentFocus);
      listening = false;
    }
    if (restoreFocus) trigger!.focus({ preventScroll: true });
  }
  function open(): void {
    if (trigger!.disabled) return;
    options!.hidden = false;
    trigger!.setAttribute("aria-expanded", "true");
    if (!listening) {
      doc.addEventListener("click", onDocumentClick, true);
      doc.addEventListener("focusin", onDocumentFocus);
      listening = true;
    }
  }
  function onDocumentClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Node) || !picker!.contains(target)) { dismiss(); return; }
    const button = target instanceof Element ? target.closest<HTMLButtonElement>("button") : null;
    // Close in capture phase without swallowing the click or awaiting anything:
    // native USB/directory choosers must retain this exact activation gesture.
    if (button && options!.contains(button) && !button.disabled) dismiss(true);
  }
  function onDocumentFocus(event: Event): void {
    if (!(event.target instanceof Node) || !picker!.contains(event.target)) dismiss();
  }
  function onToggle(): void {
    if (options!.hidden) open(); else dismiss();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && !options!.hidden) {
      event.preventDefault(); event.stopPropagation(); dismiss(true); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (options!.hidden && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open();
    const buttons = enabledOptions();
    if (!buttons.length) return;
    const current = buttons.findIndex((button) => button === doc.activeElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : current < 0 ? (event.key === "ArrowUp" ? buttons.length - 1 : 0)
        : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[index]?.focus({ preventScroll: true });
  }
  trigger.addEventListener("click", onToggle);
  picker.addEventListener("keydown", onKey);
  if (!options.hidden) open();
  return () => {
    dismiss();
    trigger.removeEventListener("click", onToggle);
    picker.removeEventListener("keydown", onKey);
  };
}
