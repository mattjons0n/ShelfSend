import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogHttpServer } from "../../server/http-server.js";
import { CatalogEventHub } from "../../server/event-hub.js";

const database = {
  initializeCoverProviderCredentials: () => undefined,
  getCoverProviderCredential: () => undefined,
  listProfiles: () => [],
};
function server(options: ConstructorParameters<typeof CatalogHttpServer>[5] = {}) {
  return new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, { close() {} } as never, options);
}
function internals(value: CatalogHttpServer) {
  return value as unknown as {
    activeBufferedResponses: number;
    acquireBufferedResponse(response: ServerResponse): Promise<() => void>;
  };
}
function response() {
  const socket = { timeout: 77, destroyed: false, setTimeout: vi.fn(function (this: { timeout: number }, timeout: number) { this.timeout = timeout; }) };
  const result = Object.assign(new EventEmitter(), { socket, destroyed: false, writableFinished: false,
    destroy: vi.fn(() => { result.destroyed = true; result.emit("close"); }),
  });
  return result;
}
afterEach(() => vi.useRealTimers());

describe("buffered response delivery deadlines", () => {
  it("keeps live events independent of ordinary request capacity and delivery deadlines", async () => {
    const events = new CatalogEventHub();
    const http = new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, events, {
      hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], maxConcurrentRequests: 1,
      bufferedResponseIdleTimeoutMs: 50, bufferedResponseTimeoutMs: 100,
    });
    const abort = new AbortController();
    try {
      const address = await http.listen();
      const url = `http://127.0.0.1:${address.port}`;
      const stream = await fetch(`${url}/api/events`, { signal: abort.signal });
      const reader = stream.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await delay(150);
      const health = await fetch(`${url}/api/healthz`);
      expect(health.status).toBe(200);
      await health.text();
      events.publish({ type: "catalog.updated" } as never);
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
    } finally {
      abort.abort();
      await http.close();
    }
  });

  it("releases stalled capacity and removes timeout listeners on expiry", async () => {
    vi.useFakeTimers();
    const http = internals(server({ maxConcurrentBufferedResponses: 1, bufferedResponseIdleTimeoutMs: 100, bufferedResponseTimeoutMs: 1_000 }));
    const first = response();
    await http.acquireBufferedResponse(first as unknown as ServerResponse);
    const second = response();
    const waiting = http.acquireBufferedResponse(second as unknown as ServerResponse);
    first.emit("timeout");
    const release = await waiting;
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(first.listenerCount("timeout")).toBe(0);
    expect(http.activeBufferedResponses).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(second.socket.timeout).toBe(77);
    expect(http.activeBufferedResponses).toBe(0);
  });

  it("bounds trickling responses and retires the absolute deadline after finish", async () => {
    vi.useFakeTimers();
    const http = internals(server({ bufferedResponseTimeoutMs: 1_000 }));
    const stalled = response();
    const finished = response();
    await http.acquireBufferedResponse(stalled as unknown as ServerResponse);
    await http.acquireBufferedResponse(finished as unknown as ServerResponse);
    finished.emit("finish");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(stalled.destroy).toHaveBeenCalledOnce();
    expect(finished.destroy).not.toHaveBeenCalled();
    expect(http.activeBufferedResponses).toBe(0);
  });

  it("releases a pipelined response which has no assigned socket and emits no close", async () => {
    vi.useFakeTimers();
    const http = internals(server({ maxConcurrentBufferedResponses: 1, bufferedResponseTimeoutMs: 100 }));
    const queued = Object.assign(new EventEmitter(), {
      socket: null, destroyed: false, writableFinished: false,
      destroy() { this.destroyed = true; },
    });
    await http.acquireBufferedResponse(queued as unknown as ServerResponse);
    await vi.advanceTimersByTimeAsync(101);
    expect(queued.destroyed).toBe(true);
    expect(http.activeBufferedResponses).toBe(0);
    const release = await http.acquireBufferedResponse(response() as unknown as ServerResponse);
    release();
  });

  it("recovers ordinary catalog and homepage requests after real clients stop reading", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-buffered-delivery-"));
    await writeFile(path.join(directory, "index.html"), "homepage");
    // Larger than TCP buffering on both macOS and Linux, within the unchanged static-file limit.
    await writeFile(path.join(directory, "stalled.wasm"), Buffer.alloc(16 * 1024 * 1024));
    const http = server({ hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], staticDirectory: directory,
      bufferedResponseIdleTimeoutMs: 200, bufferedResponseTimeoutMs: 2_000, bufferedResponseWaitTimeoutMs: 3_000 });
    const sockets: net.Socket[] = [];
    try {
      const address = await http.listen();
      for (let index = 0; index < 2; index += 1) {
        const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
        sockets.push(socket);
        socket.on("error", () => undefined);
        await once(socket, "connect");
        socket.pause();
        socket.write(`GET /stalled.wasm HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
      }
      await vi.waitFor(() => expect(internals(http).activeBufferedResponses).toBe(2), { timeout: 1_000, interval: 5 });
      await delay(2_100);
      expect(internals(http).activeBufferedResponses).toBe(0);
      for (const endpoint of ["/", "/api/profiles"]) {
        const result = await fetch(`http://127.0.0.1:${address.port}${endpoint}`);
        expect(result.status).toBe(200);
        await result.text();
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await http.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the owning connection when an asset expires behind a pipelined SSE response", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-pipelined-delivery-"));
    await writeFile(path.join(directory, "queued.wasm"), Buffer.alloc(64 * 1024));
    const events = new CatalogEventHub();
    const http = new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, events, {
      hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], staticDirectory: directory,
      maxConcurrentBufferedResponses: 1, bufferedResponseIdleTimeoutMs: 1_000, bufferedResponseTimeoutMs: 300,
    });
    const state = internals(http) as ReturnType<typeof internals> & { activeRequests: number };
    const acquire = state.acquireBufferedResponse.bind(state);
    let queuedResponse: ServerResponse | undefined;
    const capture = vi.spyOn(state, "acquireBufferedResponse").mockImplementation((response) => {
      queuedResponse = response;
      return acquire(response);
    });
    let socket: net.Socket | undefined;
    let clientClosed = false;
    let received = "";
    try {
      const address = await http.listen();
      socket = net.createConnection({ host: "127.0.0.1", port: address.port });
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
      socket.once("close", () => { clientClosed = true; });
      await once(socket, "connect");
      socket.write(
        `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`
        + `GET /queued.wasm HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`,
      );
      await vi.waitFor(() => expect(queuedResponse?.writableEnded).toBe(true), { timeout: 1_000, interval: 5 });
      expect(queuedResponse?.socket).toBeNull();
      expect(queuedResponse?.writableFinished).toBe(false);
      expect(state.activeBufferedResponses).toBe(1);
      expect(received).toContain("text/event-stream");
      await vi.waitFor(() => expect(clientClosed).toBe(true), { timeout: 1_500, interval: 5 });
      await vi.waitFor(() => {
        expect(state.activeBufferedResponses).toBe(0);
        expect(state.activeRequests).toBe(0);
      }, { timeout: 1_000, interval: 5 });
    } finally {
      capture.mockRestore();
      socket?.destroy();
      await http.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
