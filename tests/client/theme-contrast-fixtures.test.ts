// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { themeContrastFixtures } from "../fixtures/theme-contrast";

describe("real UI coverage for the computed contrast audit", () => {
  const fixtures = themeContrastFixtures();
  it("renders independently named, themed production pages without undefined placeholders", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(new Set(fixtures.map(({ name }) => name)).size).toBe(fixtures.length);
    for (const fixture of fixtures) {
      const root = document.createElement("div");
      root.innerHTML = fixture.html;
      expect(root.querySelector(".library-app-shell"), fixture.name).not.toBeNull();
      expect(root.querySelector("button"), fixture.name).not.toBeNull();
      expect(root.textContent, fixture.name).not.toContain("undefined");
    }
  });

  it.each([
    ["kindle-index-preparing", '.library-device-indexing[data-progress-phase="preparing"] [role="progressbar"]'],
    ["kindle-index-enumerating", '.library-device-indexing[data-progress-phase="discovering"] [role="progressbar"]'],
    ["kindle-index-metadata", '.library-device-indexing[data-progress-phase="indexing"] [role="progressbar"][aria-valuenow="50"]'],
    ["kindle-index-finishing", '.library-device-indexing[data-progress-phase="finishing"] [role="progressbar"]'],
    ["dashboard-active-shelf", '[data-ui-action="clear-smart-shelf"]'],
    ["dashboard-list-selected", '[data-ui-action="bulk-send-to-kindle"]'],
    ["dashboard-list-busy", '.library-bulk-actions button.primary:disabled > span'],
    ["dashboard-list-disconnected", '.library-bulk-actions button.primary:disabled > span'],
    ["dashboard-empty-filter", '.library-empty-state [data-ui-action="clear-filters"]'],
    ["kobo-connected", ".library-kobo-connection"],
    ["kobo-recovery", ".library-kobo-recovery"],
    ["settings-providers", ".settings-provider-card"],
    ["settings-provider-edit", ".settings-provider-card"],
    ["manage-shelves", ".library-shelf-sheet"],
    ["batch-transfer", ".library-batch-sheet"],
    ["batch-transfer-failed", ".library-batch-sheet"],
    ["inline-transfer-sending", '.library-inline-send .library-transfer-button[data-ui-action="cancel-book-send"]'],
    ["inline-transfer-complete", ".library-inline-send .library-transfer-button.complete"],
    ["inline-transfer-failed", ".library-inline-send .library-transfer-button.failed"],
    ["remove-confirmation", ".library-remove-sheet"],
    ["update-confirmation", ".library-update-sheet"],
    ["send-queue", ".library-queue-sheet"],
    ["book-details", ".library-book-details-sheet"],
    ["metadata-cover-results", ".metadata-candidate-review"],
    ["metadata-cover-errors", ".metadata-candidate-status.error"],
    ["hardcover-series", ".hardcover-series-sheet"],
    ["series-library", ".series-detail"],
    ["needs-attention", ".health-issue"],
    ["bulk-metadata-job", ".metadata-job-detail"],
    ["activity", ".library-activity-sheet"],
    ["match-review", ".match-review-comparison"],
  ])("includes the %s production branch", (name, selector) => {
    const root = document.createElement("div");
    root.innerHTML = fixtures.find((fixture) => fixture.name === name)!.html;
    expect(root.querySelector(selector)).not.toBeNull();
  });

  it("covers populated queue, failure, candidate, comparison, and ownership states rather than empty fallbacks", () => {
    const page = (name: string) => {
      const root = document.createElement("div");
      root.innerHTML = fixtures.find((fixture) => fixture.name === name)!.html;
      return root;
    };
    const queue = page("send-queue");
    expect(queue.querySelector(".library-queue-totals")?.textContent).toContain("Approximate transfer size");
    expect(queue.querySelector(".library-queue-list")?.children).toHaveLength(2);
    expect(queue.textContent).toContain("Source changed after it was queued");
    expect(page("batch-transfer-failed").querySelector(".library-batch-sheet")?.textContent).toContain("The connection was interrupted");
    const metadata = page("metadata-cover-results");
    expect(metadata.querySelectorAll(".metadata-candidate-card")).toHaveLength(3);
    expect(metadata.querySelector(".metadata-candidate-review")?.textContent).toContain("Choose what to import");
    expect(page("metadata-cover-errors").querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(2);
    const roster = page("hardcover-series");
    for (const status of ["in-library", "possible", "missing"]) {
      expect(roster.querySelector(`[data-library-status="${status}"]`)).not.toBeNull();
    }
    expect(page("match-review").querySelectorAll(".match-review-comparison tbody tr")).toHaveLength(5);
    expect(page("needs-attention").querySelectorAll(".health-issue")).toHaveLength(3);
    expect(page("settings-delete-confirmation").querySelector('[data-ui-action="confirm-delete-library"]')).not.toBeNull();
    expect(page("settings-stale-inventory").querySelector(".library-stale-notice")).not.toBeNull();
    expect(page("update-in-progress").querySelector(".library-transfer-status")?.textContent).toContain("Verifying the updated book");
    expect(page("update-failed").querySelector(".library-transfer-status.failed")?.textContent).toContain("Update did not complete");
    expect(page("book-details").querySelector(".library-book-details-sheet")?.textContent).toContain("Confirmed on this Kindle");
    expect(page("book-details-possible").querySelector(".library-book-details-sheet")?.textContent).toContain("Possible Kindle match");
    for (const confidence of ["high", "medium", "low"]) {
      expect(metadata.querySelector(`[data-confidence="${confidence}"]`)).not.toBeNull();
    }
    const jobs = page("bulk-metadata-job");
    expect(jobs.querySelectorAll(".metadata-job-entries > li")).toHaveLength(3);
    expect(jobs.querySelectorAll('[data-ui-action="select-hardcover-bulk-series"]')).toHaveLength(2);
    expect(jobs.querySelector('[data-ui-action="apply-hardcover-bulk-series"]')).not.toBeNull();
    expect(jobs.querySelector(".health-search-error")?.textContent).toContain("Hardcover is limiting requests");
    expect(jobs.querySelector(".metadata-job-list em[data-status='running']")).not.toBeNull();
    expect(jobs.querySelector(".metadata-job-status[data-status='completed']")).not.toBeNull();
  });
});
