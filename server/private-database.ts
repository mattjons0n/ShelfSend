import { closeSync, constants, fchmodSync, fstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Secure only the application's database files, never unrelated mount contents. */
function privateFile(filename: string, create: boolean): void {
  let descriptor: number;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0), 0o600);
  } catch (error) {
    if (!create && missing(error)) return;
    throw error;
  }
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error("The catalog database must be a regular file.");
    if ((details.mode & 0o777) !== 0o600) fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

export function openPrivateCatalogDatabase(filename: string): DatabaseSync {
  if (filename === ":memory:" || filename === "") return new DatabaseSync(filename);
  // Preserve configured symlink locations, but bind SQLite and its sidecars to
  // the canonical database location instead of following a final-component
  // symlink while repairing permissions.
  let canonical: string;
  try { canonical = realpathSync(filename); }
  catch (error) {
    if (!missing(error)) throw error;
    canonical = path.resolve(filename);
  }
  privateFile(canonical, true);
  for (const suffix of ["-wal", "-shm", "-journal"]) privateFile(`${canonical}${suffix}`, false);
  // SQLite derives new WAL/SHM permissions from the main database's mode. The
  // main file already exists as 0600 before SQLite can write any credentials.
  return new DatabaseSync(canonical);
}
