function setExpanded(button: HTMLButtonElement, expanded: boolean): void {
  const card = button.closest(".settings-provider-card");
  const panel = card?.querySelector<HTMLElement>(".settings-provider-body");
  if (!panel || panel.id !== button.getAttribute("aria-controls")) return;
  button.setAttribute("aria-expanded", String(expanded));
  panel.hidden = !expanded;
}

/** Only the explicit button toggles the panel; card text and status are inert. */
export function bindSettingsProviderDisclosure(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>(".settings-provider-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.disabled) setExpanded(button, button.getAttribute("aria-expanded") !== "true");
    });
  });
}

/** Retain expanded configuration panels across background status refreshes.
 * This stores only presentation state, never credential field values. */
export function captureSettingsProviderDisclosure(root: HTMLElement): () => void {
  const expanded = new Set([...root.querySelectorAll<HTMLButtonElement>('.settings-provider-toggle[aria-expanded="true"]')]
    .map((button) => button.getAttribute("aria-controls")));
  const active = document.activeElement;
  const focused = active instanceof HTMLButtonElement && root.contains(active) && active.matches(".settings-provider-toggle")
    ? active.getAttribute("aria-controls") : undefined;
  return () => {
    root.querySelectorAll<HTMLButtonElement>(".settings-provider-toggle").forEach((button) => {
      if (expanded.has(button.getAttribute("aria-controls"))) setExpanded(button, true);
      if (focused && focused === button.getAttribute("aria-controls") && !button.disabled) button.focus({ preventScroll: true });
    });
  };
}
