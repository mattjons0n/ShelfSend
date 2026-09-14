import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { createCatalogService, type CatalogService } from "../../server/catalog-service.js";
import { CATALOG_MIGRATIONS, CATALOG_SCHEMA_VERSION } from "../../server/migrations.js";
import type { ShelfSidebarOrder, SmartShelf } from "../../shared/catalog-contracts.js";
import { BUILT_IN_SHELF_IDS, MAX_SIDEBAR_SHELF_IDS, normalizeShelfSidebarOrder } from "../../shared/shelf-order.js";

const directories: string[] = [];
const services: CatalogService[] = [];

afterEach(async () => {
  while (services.length) await services.pop()?.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "shelfsend-sidebar-order-"));
  directories.push(directory);
  return directory;
}

async function start(directory: string) {
  const library = path.join(directory, "library");
  await mkdir(library, { recursive: true });
  const service = await createCatalogService({
    databasePath: path.join(directory, "catalog.sqlite"),
    cacheDirectory: path.join(directory, "cache"),
    allowedRootPaths: [library],
    http: {
      hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"],
      allowedOrigins: [], requireOriginForMutations: false,
    },
    scanner: { watcherHints: false, reconciliationIntervalMs: 60_000 },
  });
  services.push(service);
  const address = await service.start();
  const base = `http://127.0.0.1:${address.port}/api/profiles`;
  const order = async (profileId: string): Promise<ShelfSidebarOrder> => {
    const response = await fetch(`${base}/${profileId}/shelves/sidebar-order`);
    expect(response.status).toBe(200);
    return response.json() as Promise<ShelfSidebarOrder>;
  };
  const patch = (profileId: string, body: unknown) => fetch(`${base}/${profileId}/shelves/sidebar-order`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const createShelf = async (profileId: string, name: string, pinned = true): Promise<SmartShelf> => {
    const response = await fetch(`${base}/${profileId}/shelves`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `create-${name.replace(/\s+/gu, "-")}` },
      body: JSON.stringify({ name, query: { version: 1 }, pinned }),
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<SmartShelf>;
  };
  return { service, base, order, patch, createShelf };
}

describe("durable combined sidebar shelf order", () => {
  it("orders built-in and custom shelves together with revision guards and one event per change", async () => {
    const api = await start(await temporaryDirectory());
    const profile = api.service.database.createProfile({ name: "Reader" });
    const other = api.service.database.createProfile({ name: "Other reader" });
    expect(await api.order(profile.id)).toEqual({ profileId: profile.id, revision: 0, shelfIds: [...BUILT_IN_SHELF_IDS] });
    const custom = await api.createShelf(profile.id, "Science fiction");
    const before = await api.order(profile.id);
    expect(before.shelfIds).toEqual([...BUILT_IN_SHELF_IDS, custom.id]);
    const publish = vi.spyOn(api.service.events, "publish");
    const shelfIds = [custom.id, ...[...BUILT_IN_SHELF_IDS].reverse()];
    const response = await api.patch(profile.id, { expectedRevision: before.revision, shelfIds });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profileId: profile.id, revision: before.revision + 1, shelfIds });
    const changed = await api.order(profile.id);
    expect(changed.shelfIds).toEqual(shelfIds);
    expect((await api.patch(profile.id, { expectedRevision: changed.revision, shelfIds })).status).toBe(200);
    expect(await api.order(profile.id)).toEqual(changed);
    expect((await api.patch(profile.id, { expectedRevision: before.revision, shelfIds: before.shelfIds })).status).toBe(409);
    expect(await api.order(profile.id)).toEqual(changed);
    expect(publish.mock.calls.filter(([event]) => event.type === "shelf.updated")).toEqual([
      [{ type: "shelf.updated", profileId: profile.id, data: { sidebarReordered: true } }],
    ]);
    expect(await api.order(other.id)).toEqual({ profileId: other.id, revision: 0, shelfIds: [...BUILT_IN_SHELF_IDS] });
  });

  it("persists through HTTP service restarts and catalog rebuild, and cascades only with its profile", async () => {
    const directory = await temporaryDirectory();
    let api = await start(directory);
    const profile = api.service.database.createProfile({ name: "Reader" });
    const custom = await api.createShelf(profile.id, "My shelf");
    const initial = await api.order(profile.id);
    const shelfIds = [custom.id, ...BUILT_IN_SHELF_IDS];
    expect((await api.patch(profile.id, { expectedRevision: initial.revision, shelfIds })).status).toBe(200);
    const saved = await api.order(profile.id);
    api.service.database.database.prepare(
      `INSERT INTO profile_book_annotations(profile_id, book_id, favorite, want_to_read, read_book, revision, created_at, updated_at)
       VALUES (?, 'book_completed_123', 1, 0, 1, 1, '2026-09-01', '2026-09-01')`,
    ).run(profile.id);
    api.service.database.clearRebuildableCatalog();
    expect(await api.order(profile.id)).toEqual(saved);
    await services.pop()?.close();
    api = await start(directory);
    expect(await api.order(profile.id)).toEqual(saved);
    expect(api.service.database.getProfileBookAnnotation(profile.id, "book_completed_123")).toMatchObject({ favorite: true, readBook: true });
    api.service.database.deleteProfile(profile.id);
    expect(api.service.database.database.prepare("SELECT count(*) AS count FROM shelf_sidebar_order").get()).toEqual({ count: 0 });
    expect((await fetch(`${api.base}/${profile.id}/shelves/sidebar-order`)).status).toBe(404);
  });

  it("appends new pins, prunes unpinned/deleted shelves and invalidates stale reorder revisions", async () => {
    const api = await start(await temporaryDirectory());
    const profile = api.service.database.createProfile({ name: "Reader" });
    const one = await api.createShelf(profile.id, "One");
    const before = await api.order(profile.id);
    await api.patch(profile.id, { expectedRevision: before.revision, shelfIds: [one.id, ...BUILT_IN_SHELF_IDS] });
    const ordered = await api.order(profile.id);
    const two = await api.createShelf(profile.id, "Two");
    let current = await api.order(profile.id);
    expect(current).toEqual({ ...ordered, revision: ordered.revision + 1, shelfIds: [...ordered.shelfIds, two.id] });
    expect((await api.patch(profile.id, { expectedRevision: ordered.revision, shelfIds: ordered.shelfIds })).status).toBe(409);
    const unpin = await fetch(`${api.base}/${profile.id}/shelves/${one.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: one.revision, pinned: false }),
    });
    expect(unpin.status).toBe(200);
    const unpinned = await unpin.json() as SmartShelf;
    expect(await api.order(profile.id)).toEqual({ ...current, revision: current.revision + 1, shelfIds: [...BUILT_IN_SHELF_IDS, two.id] });
    expect((await fetch(`${api.base}/${profile.id}/shelves/${one.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: unpinned.revision, pinned: true }),
    })).status).toBe(200);
    current = await api.order(profile.id);
    expect(current.shelfIds).toEqual([...BUILT_IN_SHELF_IDS, two.id, one.id]);
    expect((await fetch(`${api.base}/${profile.id}/shelves/${two.id}?expectedRevision=${two.revision}`, { method: "DELETE" })).status).toBe(204);
    expect(await api.order(profile.id)).toEqual({ ...current, revision: current.revision + 1, shelfIds: [...BUILT_IN_SHELF_IDS, one.id] });
  });

  it("rejects malformed, oversized, duplicate, partial, foreign and unpinned orders without writes", async () => {
    const api = await start(await temporaryDirectory());
    const profile = api.service.database.createProfile({ name: "Reader" });
    const other = api.service.database.createProfile({ name: "Other reader" });
    const foreign = await api.createShelf(other.id, "Foreign");
    const unpinned = await api.createShelf(profile.id, "Unpinned", false);
    const initial = await api.order(profile.id);
    const body = { expectedRevision: initial.revision, shelfIds: [...BUILT_IN_SHELF_IDS] };
    for (const invalid of [
      { ...body, shelfIds: [...BUILT_IN_SHELF_IDS, BUILT_IN_SHELF_IDS[0]] },
      { ...body, shelfIds: Array(MAX_SIDEBAR_SHELF_IDS + 1).fill("builtin-recent") },
      { ...body, shelfIds: [] },
      { ...body, shelfIds: null },
      { ...body, shelfIds: [1, ...BUILT_IN_SHELF_IDS] },
      { ...body, shelfIds: ["x".repeat(101), ...BUILT_IN_SHELF_IDS] },
      { ...body, shelfIds: ["builtin-invalid", ...BUILT_IN_SHELF_IDS] },
      { ...body, expectedRevision: -1 },
      { ...body, expectedRevision: 0.5 },
      { ...body, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...body, unexpected: true },
    ]) expect((await api.patch(profile.id, invalid)).status).toBe(400);
    for (const id of [foreign.id, unpinned.id, "shelf_nonexistent123"]) {
      expect((await api.patch(profile.id, { ...body, shelfIds: [...BUILT_IN_SHELF_IDS, id] })).status).toBe(409);
    }
    expect(await api.order(profile.id)).toEqual(initial);
    expect((await api.patch("prf_missing123", body)).status).toBe(404);
    expect(api.service.database.database.prepare("SELECT count(*) AS count FROM shelf_sidebar_order WHERE profile_id = ?").get(profile.id)).toEqual({ count: 0 });
  });

  it("accepts the full bounded universe without treating custom shelf order as deletion authority", async () => {
    const api = await start(await temporaryDirectory());
    const profile = api.service.database.createProfile({ name: "Reader" });
    const created: SmartShelf[] = [];
    for (let index = BUILT_IN_SHELF_IDS.length; index < MAX_SIDEBAR_SHELF_IDS; index += 1) {
      created.push(await api.createShelf(profile.id, `Shelf ${index}`));
    }
    const before = await api.order(profile.id);
    const shelfIds = [...before.shelfIds].reverse();
    expect((await api.patch(profile.id, { expectedRevision: before.revision, shelfIds })).status).toBe(200);
    expect((await api.order(profile.id)).shelfIds).toEqual(shelfIds);
    expect(api.service.database.listSmartShelves(profile.id).map(({ id, revision, pinnedRank }) => ({ id, revision, pinnedRank })))
      .toEqual(created.map(({ id, revision, pinnedRank }) => ({ id, revision, pinnedRank })));
  });

  it("upgrades v19 without changing existing shelves or completed-book annotations", async () => {
    const filename = path.join(await temporaryDirectory(), "catalog.sqlite");
    const old = new DatabaseSync(filename);
    old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of CATALOG_MIGRATIONS.filter(({ version }) => version <= 19)) {
      old.exec(migration.sql);
      old.prepare("INSERT INTO schema_migrations VALUES (?, ?, '2026-09-01')").run(migration.version, migration.name);
    }
    old.exec(`
      INSERT INTO profiles(id, name, enabled, created_at, updated_at) VALUES ('prf_migration123', 'Old reader', 1, '2026-09-01', '2026-09-01');
      INSERT INTO smart_shelves(id, profile_id, name, query_version, query_json, pinned_rank, revision, created_at, updated_at)
      VALUES ('shelf_migration123', 'prf_migration123', 'Existing shelf', 1, '{"version":1}', 0, 4, '2026-09-01', '2026-09-01');
      INSERT INTO profile_book_annotations(profile_id, book_id, favorite, want_to_read, read_book, revision, created_at, updated_at)
      VALUES ('prf_migration123', 'book_completed123', 0, 0, 1, 3, '2026-09-01', '2026-09-01');
    `);
    old.close();
    const database = new CatalogDatabase(filename);
    try {
      expect(database.database.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: CATALOG_SCHEMA_VERSION });
      expect(database.getShelfSidebarOrder("prf_migration123")).toEqual({
        profileId: "prf_migration123", revision: 0, shelfIds: [...BUILT_IN_SHELF_IDS, "shelf_migration123"],
      });
      expect(database.getSmartShelf("prf_migration123", "shelf_migration123")).toMatchObject({ name: "Existing shelf", revision: 4, pinnedRank: 0 });
      expect(database.getProfileBookAnnotation("prf_migration123", "book_completed123")).toMatchObject({ readBook: true, revision: 3 });
    } finally { database.close(); }
  });

  it("normalizes stale/duplicate IDs and deterministically appends newly available shelves", () => {
    expect(normalizeShelfSidebarOrder(["removed", "c", "b", "b"], ["a", "b", "c", "d", "a"]))
      .toEqual(["c", "b", "a", "d"]);
  });
});
