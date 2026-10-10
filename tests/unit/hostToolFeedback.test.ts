import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  createCodemodeExtension,
  wrapRegisteredTools,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { registerLspTools } from "../../src/tools/registerLspTools.js";
import { LspError } from "../../src/lsp/errors.js";
import { sourceContext } from "../../src/lsp/sourceContext.js";
import { LspResultCache } from "../../src/tools/resultCache.js";
import type { LspExtensionState } from "../../src/state.js";

let dir: string;
let runner: ExtensionRunner;
type AgentTool = ExtensionToolContext["tools"][number];
type AgentToolCallOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
let tools: AgentTool[];
let events: Array<{ type: string; isError?: boolean }>;
let calls: unknown[][];
let fail: boolean;
const assistant = { role: "assistant", content: [], timestamp: 0 } as unknown as AssistantMessage;

// Private access stays in this offline host regression fixture. The nested execution, argument
// validation, wrappers, call recorder and QuickJS codemode executor are the real Pi 1.1.0 paths.
const nested = AgentSession.prototype as unknown as {
  _executeNestedToolCall: (
    this: unknown,
    parent: string,
    name: string,
    args: unknown,
    options: object,
  ) => Promise<AgentToolCallOutcome>;
};
let fixture: {
  agent: { toolExecution: string; state: { messages: AssistantMessage[]; tools: AgentTool[] } };
  _getCallableTools: () => AgentTool[];
  _findLastAssistantMessage: () => AssistantMessage;
  _beforeToolCall: () => undefined;
  _afterToolCall: () => undefined;
  _extensionRunner: ExtensionRunner;
  _emit: (event: { type: string; isError?: boolean }) => void;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lsp-host-"));
  calls = [];
  events = [];
  fail = false;
  const query = async (...args: unknown[]) => {
    calls.push(args);
    if (fail)
      throw new LspError("Invalid requested column.", "invalid-position", {
        context: sourceContext("first()\nsecond()\nfit()\nfourth()\nfifth()", 2),
      });
    return { serverId: "test-ls", rootDir: dir, filePath: "a.ts", uri: "file:///a.ts", result: null };
  };
  const factory: ExtensionFactory = (pi) =>
    registerLspTools(
      pi,
      () =>
        ({
          runtimeManager: { hover: query, definition: query, references: query, activeClients: () => [] },
          resultCache: new LspResultCache(),
          config: { catalog: { servers: {} }, warnings: [] },
        }) as unknown as LspExtensionState,
    );
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory, createCodemodeExtension({ models: false })],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, SessionManager.inMemory(dir), {} as never);
  tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
  fixture = {
    agent: { toolExecution: "parallel", state: { messages: [assistant], tools } },
    _getCallableTools: () => tools,
    _findLastAssistantMessage: () => assistant,
    _beforeToolCall: () => undefined,
    _afterToolCall: () => undefined,
    _extensionRunner: runner,
    _emit: (event) => {
      events.push(event);
    },
  };
  vi.spyOn(runner, "createContext").mockImplementation(
    () =>
      ({
        cwd: dir,
        hasUI: false,
        sessionManager: SessionManager.inMemory(dir),
        ui: { setStatus: () => undefined, theme: { fg: (_name: string, text: string) => text } },
      }) as unknown as ExtensionContext,
  );
  runner.bindCore(
    { getAllTools: () => tools, getSettings: () => ({}), appendEntry: () => undefined } as never,
    {
      getCallableTools: () => tools,
      executeTool: (parent: string, name: string, args: unknown, options: object) =>
        nested._executeNestedToolCall.call(fixture, parent, name, args, options),
    } as never,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
async function hostCall(name: string, args: AgentToolCallOutcome["toolCall"]["arguments"]) {
  return nested._executeNestedToolCall.call(fixture, "host", name, args, {});
}

describe("Pi host error and selector integration (offline)", () => {
  it.each(["lsp_hover", "lsp_definition", "lsp_references"])(
    "accepts both legal selectors for %s through real host validation",
    async (name) => {
      expect(
        (
          await hostCall(name, {
            filePath: "a.ts",
            line: 3,
            column: 4,
            ...(name === "lsp_references" ? { includeDeclaration: true } : {}),
          })
        ).isError,
      ).toBe(false);
      expect(calls[0]?.slice(0, 3)).toEqual(["a.ts", 2, 3]);
      if (name === "lsp_references") expect(calls[0]?.[3]).toBe(true);
      expect((await hostCall(name, { filePath: "a.ts", line: 3, symbol: "拟合" })).isError).toBe(false);
      expect(calls[1]?.slice(0, 3)).toEqual(["a.ts", 2, "拟合"]);
    },
  );
  it.each([
    { line: 1 },
    { line: 1, column: 1, symbol: "fit" },
    { line: 1, symbol: "" },
    { line: 1, symbol: "fit()" },
    { line: 1, symbol: "fit\n" },
    { line: 0, column: 1 },
    { line: 1.5, column: 1 },
  ])("rejects invalid arguments before runtime execution: %j", async (selector) => {
    expect(
      (await hostCall("lsp_hover", { filePath: "a.ts", ...selector } as AgentToolCallOutcome["toolCall"]["arguments"]))
        .isError,
    ).toBe(true);
    expect(calls).toEqual([]);
  });
  it("preserves isError and all five real source lines in direct and nested execution", async () => {
    fail = true;
    const direct = await tools
      .find((tool) => tool.name === "lsp_hover")!
      .execute("direct", { filePath: "a.ts", line: 3, column: 99 });
    expect(direct.isError).toBe(true);
    const outcome = await runner
      .createToolContext("parent", undefined)
      .executeTool("lsp_hover", { filePath: "a.ts", line: 3, column: 99 });
    expect(outcome.isError).toBe(true);
    for (const result of [direct, outcome.result]) {
      expect(result.details).toMatchObject({ ok: false, category: "invalid-position", retryable: false });
      const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      for (const [i, line] of ["first()", "second()", "fit()", "fourth()", "fifth()"].entries())
        expect(text).toContain(`${i + 1} | ${line}`);
      expect(text).toContain("Locate the intended symbol");
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", isError: true }));
  });
  it("codemode rejects plain-text LSP failures; catching them does not mark the nested call successful", async () => {
    fail = true;
    const failed = await hostCall("codemode", { code: 'await tools.lsp_hover({filePath:"a.ts",line:3,column:99});' });
    expect(failed.isError).toBe(true);
    expect(failed.result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).toContain(
      "[invalid-position]",
    );
    expect(failed.result.details).toMatchObject({
      calls: [expect.objectContaining({ name: "lsp_hover", status: "error" })],
    });
    const caught = await hostCall("codemode", {
      code: 'const results = await Promise.allSettled([tools.lsp_hover({filePath:"a.ts",line:3,column:99})]); text(results[0].status); text(results[0].reason.message);',
    });
    expect(caught.isError).toBe(false);
    expect(caught.result.details).toMatchObject({ calls: [expect.objectContaining({ status: "error" })] });
    const text = caught.result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain("rejected");
    expect(text).toContain("1 | first()");
    expect(text).toContain("5 | fifth()");
    expect(text).toContain("Locate the intended symbol");
  });
});
