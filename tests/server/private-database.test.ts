import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";

const directories: string[] = [];
const databases: CatalogDatabase[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});
function fixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "kindle-private-database-"));
  directories.push(directory);
  return path.join(directory, "catalog.sqlite");
}
function open(filename: string): CatalogDatabase {
  const database = new CatalogDatabase(filename);
  databases.push(database);
  return database;
}
function expectPrivate(filename: string): void {
  for (const suffix of ["", "-wal", "-shm"]) expect(statSync(filename + suffix).mode & 0o777).toBe(0o600);
}

describe("credential-bearing SQLite file permissions", () => {
  it("creates private database and sidecars even in a traversable directory", () => {
    const filename = fixture();
    chmodSync(path.dirname(filename), 0o755);
    const database = open(filename);
    database.initializeCoverProviderCredentials("test-only-private-token");
    expectPrivate(filename);
    expect(database.getCoverProviderCredential("google-books")?.apiKey).toBe("test-only-private-token");
    // Do not alter a pre-existing mount directory or unrelated files.
    expect(statSync(path.dirname(filename)).mode & 0o777).toBe(0o755);
  });

  it("repairs legacy database/WAL/SHM permissions before reading existing credentials", () => {
    const filename = fixture();
    const original = open(filename);
    original.initializeCoverProviderCredentials("retained-test-token");
    for (const suffix of ["", "-wal", "-shm"]) chmodSync(filename + suffix, 0o644);
    const reopened = open(filename);
    expectPrivate(filename);
    expect(reopened.getCoverProviderCredential("google-books")?.apiKey).toBe("retained-test-token");
  });

  it("preserves configured database symlinks and secures their canonical sidecars", () => {
    const filename = fixture();
    const original = open(filename);
    original.initializeCoverProviderCredentials("canonical-test-token");
    const link = path.join(path.dirname(filename), "configured.sqlite");
    symlinkSync(filename, link);
    for (const suffix of ["", "-wal", "-shm"]) chmodSync(filename + suffix, 0o644);
    expect(open(link).getCoverProviderCredential("google-books")?.apiKey).toBe("canonical-test-token");
    expectPrivate(filename);
  });

  it("rejects symlinked sidecars without changing the target file", () => {
    const filename = fixture();
    const other = path.join(path.dirname(filename), "unrelated.txt");
    writeFileSync(other, "preserve", { mode: 0o644 });
    symlinkSync(other, `${filename}-wal`);
    expect(() => open(filename)).toThrow();
    expect(readFileSync(other, "utf8")).toBe("preserve");
    expect(statSync(other).mode & 0o777).toBe(0o644);
  });

  it("continues supporting in-memory catalogs", () => {
    expect(open(":memory:").listProfiles()).toEqual([]);
  });

  it("rejects FIFO database paths promptly instead of blocking startup", () => {
    const filename = fixture();
    expect(spawnSync("mkfifo", [filename]).status).toBe(0);
    const helper = new URL("../../server/private-database.ts", import.meta.url).href;
    const script = `import { openPrivateCatalogDatabase } from ${JSON.stringify(helper)};
      try { openPrivateCatalogDatabase(process.argv[1]); process.exitCode = 1; }
      catch (error) { if (!error.message.includes('regular file')) throw error; }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, filename], { timeout: 3_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
