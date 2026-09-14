import type { AppState } from "./state";

export interface KindleConnectionProgress {
  readonly phase: "connecting" | "preparing" | "discovering" | "indexing" | "finishing";
  readonly title: string;
  readonly detail: string;
  /** Progress through known book checks, not an estimate of elapsed time. */
  readonly percent?: number;
}

function count(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(Math.floor(value)) && value >= 0
    ? Math.floor(value) : undefined;
}

/** Display only: never contributes to device readiness or match authority. */
export function kindleConnectionProgress(state: AppState): KindleConnectionProgress | undefined {
  if (["requesting-permission", "opening", "mtp-reading"].includes(state.device.kind)) {
    return { phase: "connecting", title: "Connecting Kindle…", detail: "Waiting for your Kindle" };
  }
  if (state.device.kind !== "ready" || state.catalogInventoryState === "failed"
    || state.selfTest.kind === "failed") return undefined;
  if (state.postConnectStage === "safe-write") {
    return { phase: "preparing", title: "Preparing Kindle…", detail: "Getting ready to check your books" };
  }
  if (state.postConnectStage === "reconciliation") {
    return { phase: "finishing", title: "Finishing up…", detail: "Updating your library" };
  }
  if (state.postConnectStage !== "inventory") return undefined;
  const progress = state.kindleIndexProgress;
  const completed = count(progress?.completed) ?? 0;
  if (progress?.phase === "metadata") {
    const total = count(progress.total);
    const checked = total === undefined ? completed : Math.min(completed, total);
    return {
      phase: "indexing", title: "Indexing Kindle…",
      detail: total === 0 ? "Finishing book checks"
        : total === undefined ? `${checked.toLocaleString()} books checked`
        : `${checked.toLocaleString()} of ${total.toLocaleString()} books checked`,
      ...(total !== undefined && total > 0 ? { percent: Math.floor((checked / total) * 100) } : {}),
    };
  }
  return {
    phase: "discovering", title: "Finding books…",
    detail: completed > 0 ? `${completed.toLocaleString()} items found` : "Reading your Kindle’s contents",
  };
}

export function renderKindleIndexProgressContent(progress: KindleConnectionProgress): string {
  const measured = progress.percent !== undefined;
  return `<span class="library-device-progress-heading"><strong>${progress.title}</strong>${measured ? `<span class="library-device-progress-percent" aria-hidden="true">${progress.percent}%</span>` : ""}</span>
    <span class="progress-track" role="progressbar" aria-label="${progress.title}" aria-valuemin="0" aria-valuemax="100"${measured ? ` aria-valuenow="${progress.percent}"` : ""} aria-valuetext="${progress.detail}" data-indeterminate="${!measured}"><span${measured ? ` style="width:${progress.percent}%"` : ""}></span></span>
    <small>${progress.detail}</small>`;
}
