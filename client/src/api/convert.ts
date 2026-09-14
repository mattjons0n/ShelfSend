import { AppError } from "../app-error";
import { MAX_BOOK_SOURCE_BYTES, MAX_KINDLE_ARTIFACT_BYTES } from "../book-limits";
import {
  hasConversionOverrides,
  resolveConversionOverrides,
  type ConversionOverrides,
} from "./conversion-overrides";
import { createEphemeralEpubDerivative } from "./epub-overrides";

export interface BookMetadata {
  readonly title: string;
  readonly authors: readonly string[];
  readonly language: string;
  readonly chapters: number;
  readonly toc_entries: number;
}

export interface ConversionResult {
  readonly filename: string;
  readonly blob: Blob;
  readonly metadata: BookMetadata;
  readonly diagnostics: {
    readonly engine: "boko-wasm";
    readonly runsLocally: true;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly kindleDocumentType: "PDOC";
    readonly embeddedCover: boolean;
    readonly overridesApplied?: boolean;
  };
}

interface WorkerSuccess {
  readonly type: "success";
  readonly output: ArrayBuffer;
  readonly metadata: BookMetadata;
  readonly kindleDocumentType: "PDOC";
  readonly embeddedCover: boolean;
  readonly overridesApplied: boolean;
}

interface WorkerFailure {
  readonly type: "error";
  readonly message: string;
  readonly code?: "CONVERSION_OUTPUT_TOO_LARGE";
  readonly details?: Readonly<Record<string, unknown>>;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

const CONVERSION_TIMEOUT_MS = 5 * 60 * 1_000;

function outputName(inputName: string): string {
  const stem = inputName.replace(/\.epub$/iu, "").trim() || "book";
  return `${stem}.azw3`;
}

export async function convertEpub(
  file: File,
  signal?: AbortSignal,
  overrides?: ConversionOverrides,
): Promise<ConversionResult> {
  if (!/\.epub$/iu.test(file.name)) {
    throw new AppError("CONVERSION_INVALID_INPUT", "Choose a file with the .epub extension");
  }
  if (file.size === 0) {
    throw new AppError("CONVERSION_INVALID_INPUT", "The selected EPUB is empty");
  }
  if (file.size > MAX_BOOK_SOURCE_BYTES) {
    throw new AppError("REQUEST_TOO_LARGE", "The selected EPUB exceeds the 200 MB limit", {
      details: { inputBytes: file.size, maximumBytes: MAX_BOOK_SOURCE_BYTES },
    });
  }
  if (signal?.aborted) {
    throw new AppError("CONVERSION_ABORTED", "Conversion was cancelled");
  }

  return new Promise<ConversionResult>((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    let stopped: AppError | undefined;
    const deadline = performance.now() + CONVERSION_TIMEOUT_MS;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker?.terminate();
      callback();
    };
    const stop = (reason: AppError): void => {
      stopped ??= reason;
      finish(() => reject(stopped));
    };
    const onAbort = (): void => stop(new AppError("CONVERSION_ABORTED", "Conversion was cancelled"));
    const timeout = globalThis.setTimeout(() => {
      stop(new AppError("CONVERSION_TIMEOUT", "Local conversion exceeded five minutes"));
    }, CONVERSION_TIMEOUT_MS);
    const checkpoint = (): void => {
      if (stopped) throw stopped;
      if (signal?.aborted) throw new AppError("CONVERSION_ABORTED", "Conversion was cancelled");
      if (performance.now() >= deadline) {
        throw new AppError("CONVERSION_TIMEOUT", "Local conversion exceeded five minutes");
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    // The lifecycle boundary includes source/cover reads and EPUB editing,
    // before the WASM worker exists. Late reads cannot start a cancelled job.
    void (async () => {
      checkpoint();
      const sourceInput = await file.arrayBuffer();
      checkpoint();
      const resolvedOverrides = await resolveConversionOverrides(overrides, signal);
      checkpoint();
      const derivative = resolvedOverrides
        ? await createEphemeralEpubDerivative(new Uint8Array(sourceInput), resolvedOverrides, checkpoint)
        : undefined;
      checkpoint();
      // Derivatives own their exact-size buffer; transfer it without making a
      // second potentially 200 MiB main-thread copy.
      const input = derivative ? derivative.buffer as ArrayBuffer : sourceInput;
      worker = new Worker(new URL("./convert.worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("error", (event) => {
        finish(() => reject(new AppError("CONVERSION_FAILED", event.message || "The local converter worker failed")));
      });
      worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (response.type === "error") {
          finish(() => reject(new AppError(response.code ?? "CONVERSION_FAILED", response.message, {
            ...(response.details === undefined ? {} : { details: response.details }),
          })));
          return;
        }
        if (response.output.byteLength > MAX_KINDLE_ARTIFACT_BYTES) {
          finish(() => reject(new AppError(
            "CONVERSION_OUTPUT_TOO_LARGE",
            "The converted Kindle artifact exceeds the 200 MB browser limit",
            { details: { outputBytes: response.output.byteLength, maximumBytes: MAX_KINDLE_ARTIFACT_BYTES } },
          )));
          return;
        }
        const bytes = new Uint8Array(response.output);
        const signature = new TextDecoder("ascii").decode(bytes.subarray(60, 68));
        if (bytes.byteLength < 78 || signature !== "BOOKMOBI") {
          finish(() => reject(new AppError(
            "CONVERSION_FAILED",
            "The local converter returned an invalid AZW3 container",
            { details: { outputBytes: bytes.byteLength, signature } },
          )));
          return;
        }
        finish(() => resolve({
          filename: outputName(file.name),
          blob: new Blob([bytes], { type: "application/vnd.amazon.mobi8-ebook" }),
          metadata: response.metadata,
          diagnostics: {
            engine: "boko-wasm",
            runsLocally: true,
            inputBytes: file.size,
            outputBytes: bytes.byteLength,
            kindleDocumentType: response.kindleDocumentType,
            embeddedCover: response.embeddedCover,
            overridesApplied: response.overridesApplied,
          },
        }));
      });
      worker.postMessage({ input, overridesApplied: hasConversionOverrides(overrides) }, [input]);
    })().catch((error: unknown) => finish(() => reject(error)));
  });
}
