import { AppError } from "../app-error";
import { MAX_BOOK_SOURCE_BYTES } from "../book-limits";
import type { CatalogTransferBook } from "../catalog-transfer";
import { resolveConversionOverrides, type ConversionOverrides } from "../api/conversion-overrides";
import { createEphemeralEpubDerivative, validateEpubForReader } from "../api/epub-overrides";

export type KoboPreparationPhase = "preparing" | "validating" | "ready";

export interface PreparedKoboArtifact {
  readonly blob: Blob;
  readonly filename: string;
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly overridesApplied: boolean;
}

export interface PrepareKoboArtifactOptions {
  readonly signal?: AbortSignal;
  readonly overrides?: ConversionOverrides;
  readonly onPhase?: (phase: KoboPreparationPhase) => void;
}

const PREPARATION_TIMEOUT_MS = 2 * 60 * 1_000;

function filename(book: CatalogTransferBook): string {
  const candidate = book.sourceFilename?.trim() || book.title.trim();
  const stem = candidate.replace(/\.epub$/iu, "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu, "-")
    .replace(/^[. ]+|[. ]+$/gu, "").slice(0, 120).trim();
  return `${stem || "book"}.epub`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Prepare a verified EPUB copy, never an AZW3 conversion or a device write. */
export async function prepareKoboArtifact(
  book: CatalogTransferBook,
  source: Blob,
  options: PrepareKoboArtifactOptions = {},
): Promise<PreparedKoboArtifact> {
  let stopped: AppError | undefined;
  const deadline = performance.now() + PREPARATION_TIMEOUT_MS;
  let stop!: (reason: AppError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = (reason) => { stopped ??= reason; reject(stopped); };
  });
  const onAbort = () => stop(new AppError("CONVERSION_ABORTED", "Book preparation was cancelled"));
  const timeout = globalThis.setTimeout(() => stop(new AppError(
    "CONVERSION_TIMEOUT", "Preparing this EPUB took too long. Try again with a smaller book.",
  )), PREPARATION_TIMEOUT_MS);
  const checkpoint = () => {
    if (stopped) throw stopped;
    if (options.signal?.aborted) throw new AppError("CONVERSION_ABORTED", "Book preparation was cancelled");
    if (performance.now() >= deadline) {
      throw new AppError("CONVERSION_TIMEOUT", "Preparing this EPUB took too long. Try again with a smaller book.");
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([interrupted, (async (): Promise<PreparedKoboArtifact> => {
      checkpoint();
      options.onPhase?.("preparing");
      checkpoint();
      if (book.format.trim().toUpperCase() !== "EPUB") {
        throw new AppError("CONVERSION_INVALID_INPUT", "Kobo transfers currently support EPUB books only. Choose an EPUB copy of this book.");
      }
      if (source.size === 0) throw new AppError("CONVERSION_INVALID_INPUT", "The catalog source is empty");
      if (source.size > MAX_BOOK_SOURCE_BYTES) {
        throw new AppError("REQUEST_TOO_LARGE", "This EPUB exceeds the 200 MiB transfer limit");
      }
      if (!Number.isSafeInteger(book.size) || source.size !== book.size) {
        throw new AppError("CATALOG_SOURCE_CHANGED", "The book changed since it was indexed. Refresh the library before sending it.");
      }
      const expectedHash = book.contentHash?.trim().toLowerCase().replace(/^sha256[:-]/u, "");
      if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
        throw new AppError("CATALOG_HASH_MISSING", "The catalog did not provide a valid source hash");
      }
      const input = new Uint8Array(await source.arrayBuffer());
      checkpoint();
      if (input.byteLength !== book.size) throw new AppError("CATALOG_SOURCE_CHANGED", "The source download was incomplete");
      const sourceHash = await sha256(input);
      checkpoint();
      if (sourceHash !== expectedHash) {
        throw new AppError("CATALOG_SOURCE_CHANGED", "The book changed since it was indexed. Refresh the library before sending it.");
      }
      options.onPhase?.("validating");
      const validation = await validateEpubForReader(input, checkpoint);
      checkpoint();
      const overrides = await resolveConversionOverrides(options.overrides, options.signal);
      checkpoint();
      if (validation.hasObfuscatedFonts && overrides?.identifiers !== undefined) {
        throw new AppError("CONVERSION_INVALID_INPUT", "This EPUB uses its original identifier to unlock embedded fonts. Keep the source identifiers before sending it to Kobo.");
      }
      const output = overrides ? await createEphemeralEpubDerivative(input, overrides) : input;
      checkpoint();
      if (output.byteLength > MAX_BOOK_SOURCE_BYTES) {
        throw new AppError("CONVERSION_OUTPUT_TOO_LARGE", "The prepared EPUB exceeds the 200 MiB transfer limit");
      }
      if (overrides) await validateEpubForReader(output, checkpoint);
      checkpoint();
      const artifactHash = output === input ? sourceHash : await sha256(output);
      checkpoint();
      const blob = new Blob([output as Uint8Array<ArrayBuffer>], { type: "application/epub+zip" });
      options.onPhase?.("ready");
      return { blob, filename: filename(book), sourceHash, artifactHash, overridesApplied: overrides !== undefined };
    })()]);
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
