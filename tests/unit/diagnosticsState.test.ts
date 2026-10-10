import { EventEmitter } from "node:events";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspClient, type LspConnection, type LspServerProcess } from "../../src/lsp/client.js";
import { LspRuntimeManager } from "../../src/lsp/runtimeManager.js";
import type { ResolvedServerConfig } from "../../src/registry/schema.js";
import { formatDiagnostics } from "../../src/tools/lspFormat.js";
import { LspResultCache } from "../../src/tools/resultCache.js";

let dir: string;
let proc: FakeProcess;
let connection: FakeConnection;
let client: LspClient;
let runtime: LspRuntimeManager | undefined;

class FakeProcess extends EventEmitter implements LspServerProcess {
  pid = 9876;
  kill(): boolean {
    this.emit("exit", 0, null);
    return true;
  }
}
class FakeConnection implements LspConnection {
  handlers = new Map<string, (params: unknown) => void>();
  notifications: Array<{ method: string; params: unknown }> = [];
  requests: Array<{ method: string; params: unknown }> = [];
  onSync?: (uri: string, version: number) => void;
  listen(): void {}
  async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return (method === "initialize" ? { capabilities: {} } : null) as T;
  }
  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
    if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
      const doc = (params as { textDocument: { uri: string; version: number } }).textDocument;
      this.onSync?.(doc.uri, doc.version);
    }
  }
  publish(uri: string, version?: number, diagnostics: unknown[] = []): void {
    this.handlers.get("textDocument/publishDiagnostics")?.({ uri, version, diagnostics });
  }
  onNotification(method: string, handler: (params: unknown) => void) {
    this.handlers.set(method, handler);
    return {
      dispose: () => {
        this.handlers.delete(method);
      },
    };
  }
  onRequest() {
    return { dispose: () => undefined };
  }
  dispose(): void {}
  end(): void {}
}
const diagnostic = {
  message: "synthetic error",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 1 as const,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lsp-diagnostics-"));
  proc = new FakeProcess();
  connection = new FakeConnection();
  client = new LspClient({
    id: "synthetic",
    ownerId: "test",
    config: config(),
    processRegistry: { register: async () => undefined, unregister: async () => undefined } as never,
    spawner: () => proc,
    connectionFactory: () => connection,
    shutdownGraceMs: 0,
  });
  await client.start();
});
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await client.shutdown();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
function config(): ResolvedServerConfig {
  return {
    server: {
      id: "test-ls",
      displayName: "Test",
      filetypes: ["typescript"],
      rootMarkers: [],
      install: { type: "system", command: ["fake"] },
      command: ["fake"],
      env: {},
      settings: {},
      initializationOptions: {},
      lazy: true,
    },
    rootDir: dir,
    command: ["fake"],
    cwd: dir,
    env: {},
    settings: {},
    initializationOptions: {},
  };
}
async function document(text = "const x = 1;") {
  return client.syncDocument(join(dir, "a.ts"), "typescript", text);
}
function makeRuntime(wait = 30) {
  runtime = new LspRuntimeManager({
    cwd: dir,
    ownerId: "test",
    config: { catalog: { servers: { "test-ls": config().server } }, warnings: [], installMode: "auto", warmup: true },
    installManager: {
      ensureInstalled: async () => ({
        status: "installed",
        metadata: { installer: "system", resolvedCommand: ["fake"], installedAt: "synthetic" },
      }),
    } as never,
    processRegistry: { register: async () => undefined, unregister: async () => undefined } as never,
    lockfileOptions: { lockfilePath: join(dir, "lock.json") },
    spawner: () => proc,
    connectionFactory: () => connection,
    diagnosticsWaitMs: wait,
    shutdownGraceMs: 0,
  });
  return runtime;
}

describe("diagnostic publication sequence contract", () => {
  it("declares version support and UTF-16 only", () => {
    expect(connection.requests[0]?.params).toMatchObject({
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: { publishDiagnostics: { versionSupport: true } },
      },
    });
  });
  it("distinguishes no publication from a matching empty publication", async () => {
    const doc = await document();
    expect(await client.waitForDiagnostics(doc, 0)).toMatchObject({
      status: "pending",
      received: false,
      diagnostics: [],
    });
    connection.publish(doc.uri, doc.version);
    expect(await client.waitForDiagnostics(doc, 0)).toMatchObject({
      status: "fresh",
      received: true,
      publicationVersion: 1,
      diagnostics: [],
    });
  });
  it("returns matching nonempty results immediately and keeps unknown versions unverified", async () => {
    const doc = await document();
    connection.publish(doc.uri, 1, [diagnostic]);
    expect(await client.waitForDiagnostics(doc, 1000)).toMatchObject({ status: "fresh", diagnostics: [diagnostic] });
    connection.publish(doc.uri, undefined);
    expect(await client.waitForDiagnostics(doc, 1000)).toMatchObject({
      status: "unverified",
      diagnostics: [],
      knownPublicationVersion: 1,
    });
  });
  it("never allows older out-of-order notifications to replace newer version evidence", async () => {
    const first = await document();
    const second = await document("const x = 2;");
    connection.publish(first.uri, 2, [diagnostic]);
    connection.publish(first.uri, 1);
    expect(await client.waitForDiagnostics(second, 0)).toMatchObject({
      status: "fresh",
      publicationVersion: 2,
      diagnostics: [diagnostic],
    });
    connection.publish(first.uri, undefined);
    connection.publish(first.uri, 1);
    expect(await client.waitForDiagnostics(second, 0)).toMatchObject({
      status: "unverified",
      knownPublicationVersion: 2,
    });
  });
  it("waits for delayed matching results, but bounds pending and stale waits", async () => {
    const doc = await document();
    const waiting = client.waitForDiagnostics(doc, 100);
    connection.publish(doc.uri, 0, [diagnostic]);
    setTimeout(() => connection.publish(doc.uri, 1), 5);
    expect(await waiting).toMatchObject({ status: "fresh", diagnostics: [] });
    const second = await document("second");
    expect(await client.waitForDiagnostics(second, 5)).toMatchObject({
      status: "stale",
      publicationVersion: 1,
      targetVersion: 2,
    });
  });
  it("captures immutable versions through synchronous publication and quick 1→2→3 updates", async () => {
    connection.onSync = (uri, version) => connection.publish(uri, version);
    const first = await document("first");
    const second = await document("second");
    const third = await document("third");
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(third.version).toBe(3);
    expect(await client.waitForDiagnostics(first, 0)).toMatchObject({
      status: "stale",
      targetVersion: 1,
      currentVersion: 3,
    });
    expect(await client.waitForDiagnostics(third, 0)).toMatchObject({ status: "fresh", targetVersion: 3 });
  });
  it("isolates same-document concurrent waiters and cancels independently", async () => {
    const first = await document();
    const controller = new AbortController();
    const cancelled = client.waitForDiagnostics(first, 500, controller.signal);
    const assertion = expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    const old = client.waitForDiagnostics(first, 500);
    controller.abort();
    await assertion;
    const second = await document("second");
    const current = client.waitForDiagnostics(second, 500);
    connection.publish(first.uri, 2);
    expect(await old).toMatchObject({ status: "stale", targetVersion: 1 });
    expect(await current).toMatchObject({ status: "fresh", targetVersion: 2 });
    expect((client as unknown as { diagnosticListeners: Set<unknown> }).diagnosticListeners.size).toBe(0);
  });
  it.each(["exit", "shutdown"])("settles waiting queries on %s", async (action) => {
    const doc = await document();
    const waiting = client.waitForDiagnostics(doc, 500);
    const assertion = expect(waiting).rejects.toMatchObject({ code: action === "exit" ? "server-exited" : "shutdown" });
    if (action === "exit") proc.emit("exit", 0, null);
    else await client.shutdown();
    await assertion;
    expect((client as unknown as { diagnosticListeners: Set<unknown> }).diagnosticListeners.size).toBe(0);
  });
  it("exhausts a no-publication budget and leaves no diagnostic timers/listeners", async () => {
    const doc = await document();
    vi.useFakeTimers();
    try {
      const waiting = client.waitForDiagnostics(doc, 350);
      await vi.advanceTimersByTimeAsync(350);
      expect(await waiting).toMatchObject({ status: "pending", received: false });
      expect(vi.getTimerCount()).toBe(0);
      expect((client as unknown as { diagnosticListeners: Set<unknown> }).diagnosticListeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a server choosing non-UTF-16 coordinates", async () => {
    vi.spyOn(connection, "sendRequest").mockResolvedValue({ capabilities: { positionEncoding: "utf-8" } });
    await expect(client.start()).rejects.toMatchObject({ code: "start-failed" });
  });

  it("rejects an already aborted query even when matching cache exists", async () => {
    const doc = await document();
    connection.publish(doc.uri, 1);
    const controller = new AbortController();
    controller.abort();
    await expect(client.waitForDiagnostics(doc, 0, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("runtime freshness and paginated snapshot semantics", () => {
  it("checks disk before declaring fresh and distinguishes no-version notifications", async () => {
    await writeFile(join(dir, "a.ts"), "first");
    connection.onSync = (uri, version) => connection.publish(uri, version);
    const manager = makeRuntime(0);
    expect(await manager.diagnostics("a.ts")).toMatchObject({
      status: "fresh",
      diskCheck: "matched",
      targetVersion: 1,
    });
    await writeFile(join(dir, "a.ts"), "second");
    connection.onSync = (uri) => connection.publish(uri);
    expect(await manager.diagnostics("a.ts")).toMatchObject({ status: "unverified", targetVersion: 2 });
  });
  it("marks a query stale if the file changes while it waits", async () => {
    await writeFile(join(dir, "a.ts"), "first");
    connection.onSync = (uri, version) => {
      void writeFile(join(dir, "a.ts"), "changed").then(() => connection.publish(uri, version));
    };
    expect(await makeRuntime().diagnostics("a.ts")).toMatchObject({ status: "stale", diskCheck: "changed" });
  });
  it("downgrades a version match when return-time disk verification is unavailable", async () => {
    await writeFile(join(dir, "a.ts"), "first");
    connection.onSync = (uri, version) => {
      void unlink(join(dir, "a.ts")).then(() => connection.publish(uri, version));
    };
    expect(await makeRuntime().diagnostics("a.ts")).toMatchObject({
      status: "unverified",
      diskCheck: "unavailable",
      publicationVersion: 1,
    });
  });

  it("isolates concurrent runtime queries against rapid warmup version changes", async () => {
    await writeFile(join(dir, "a.ts"), "first");
    let opened!: () => void;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    connection.onSync = () => opened();
    const manager = makeRuntime(500);
    const old = manager.diagnostics("a.ts");
    await open;
    await writeFile(join(dir, "a.ts"), "second");
    await manager.warmupFile("a.ts");
    await writeFile(join(dir, "a.ts"), "third");
    connection.onSync = (uri, version) => connection.publish(uri, version);
    const current = manager.diagnostics("a.ts");
    expect(await old).toMatchObject({ status: "stale", targetVersion: 1 });
    expect(await current).toMatchObject({ status: "fresh", targetVersion: 3, publicationVersion: 3 });
    expect(manager.activeClients()).toHaveLength(1);
  });

  it("isolates caches after restart", async () => {
    await writeFile(join(dir, "a.ts"), "first");
    connection.onSync = (uri, version) => connection.publish(uri, version);
    const manager = makeRuntime(0);
    expect((await manager.diagnostics("a.ts")).status).toBe("fresh");
    await manager.stopServer();
    proc = new FakeProcess();
    connection = new FakeConnection();
    expect(await manager.diagnostics("a.ts")).toMatchObject({ status: "pending", received: false });
  });
  it.each(["pending", "fresh", "stale", "unverified"] as const)(
    "keeps %s status visible on empty results",
    (status) => {
      const result = formatDiagnostics({
        serverId: "test-ls",
        rootDir: dir,
        filePath: "a.ts",
        uri: "file:///a.ts",
        diagnostics: [],
        status,
        targetVersion: 2,
        currentVersion: 2,
        received: status !== "pending",
        diskCheck: "matched",
      });
      expect(result.content[0].text).toContain(status);
      expect(result.content[0].text).not.toContain("No LSP diagnostics");
      expect(result.details.status).toBe(status);
      expect(result.isError).not.toBe(true);
    },
  );
  it("retains original status and version evidence in cached pages", async () => {
    const cache = new LspResultCache();
    const result = formatDiagnostics(
      {
        serverId: "test-ls",
        rootDir: dir,
        filePath: "a.ts",
        uri: "file:///a.ts",
        diagnostics: [diagnostic, diagnostic],
        status: "fresh",
        targetVersion: 2,
        currentVersion: 2,
        publicationVersion: 2,
        received: true,
        diskCheck: "matched",
      },
      cache,
      { pageSize: 1 },
    );
    const page = cache.next(result.details.resultId!);
    expect(page.details).toMatchObject({ status: "fresh", targetVersion: 2, publicationVersion: 2 });
    expect(page.content[0].text).toContain("Original query snapshot");
    expect(page.content[0].text).toContain("fresh");
  });
});
