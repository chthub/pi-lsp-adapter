import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import extension from "../../src/index.js";

type Handler = (event: unknown, ctx: FakeContext) => Promise<unknown> | unknown;

interface CommandHandler {
  description?: string;
  handler: (args: string, ctx: FakeContext) => Promise<void> | void;
}

interface ToolHandler {
  name: string;
}

interface FakeContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    theme: { fg: (_name: string, text: string) => string };
    notifications: Array<{ message: string; level: string }>;
    statuses: Record<string, string | undefined>;
    notify: (message: string, level: string) => void;
    setStatus: (key: string, value: string | undefined) => void;
    confirm: () => Promise<boolean>;
  };
}

let originalHome: string | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "pi-lsp-index-home-"));
  tempProject = await mkdtemp(join(tmpdir(), "pi-lsp-index-project-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
  await rm(tempProject, { recursive: true, force: true });
});

describe("extension entrypoint", () => {
  it("registers /lsp and initializes lifecycle state on session_start", async () => {
    const pi = fakePi();
    extension(pi.api);

    expect(pi.commands.has("lsp")).toBe(true);
    expect(pi.tools.has("lsp_diagnostics")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);

    const ctx = fakeContext();
    await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await pi.commands.get("lsp")?.handler("status", ctx);
    const event = beforeAgentEvent();
    const beforeAgent = await pi.handlers.get("before_agent_start")?.(event, ctx);

    expect(ctx.ui.statuses.lsp).toMatch(/LSP: 0\/\d+ servers/u);
    expect(ctx.ui.notifications.at(-1)?.message).toContain("LSP status");
    expect(beforeAgent).toBeUndefined();
    expect(event.systemPromptOptions.sections.lsp_integration).toContain("LSP integration");
    expect(event.systemPromptOptions.forceSystemPrompt).toBeUndefined();

    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    expect(ctx.ui.statuses.lsp).toBeUndefined();
  });

  it("leaves the prompt untouched before initialization and after shutdown", async () => {
    const pi = fakePi();
    extension(pi.api);
    const ctx = fakeContext();
    const handler = pi.handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const event = beforeAgentEvent();
    const original = structuredClone(event);

    expect(await handler?.(event, ctx)).toBeUndefined();
    expect(event).toEqual(original);
    await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const initialized = beforeAgentEvent();
    await handler?.(initialized, ctx);
    expect(initialized.systemPromptOptions.sections.lsp_integration).toContain("LSP integration");
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    expect(await handler?.(event, ctx)).toBeUndefined();
    expect(event).toEqual(original);
  });

  it("changes only its named section and stays stable across repeated runs", async () => {
    const pi = fakePi();
    extension(pi.api);
    const ctx = fakeContext();
    await pi.handlers.get("session_start")?.({ reason: "startup" }, ctx);
    // Assert successful initialization, not merely the !state early return.
    expect(ctx.ui.statuses.lsp).toMatch(/LSP: 0\/\d+ servers/u);
    const handler = pi.handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const event = beforeAgentEvent();
    const original = structuredClone(event);

    expect(await handler?.(event, ctx)).toBeUndefined();
    const guidance = event.systemPromptOptions.sections.lsp_integration;
    expect(guidance).toContain("read-only LSP tools");
    expect(guidance).toContain("1-based line/column");
    expect(guidance).toContain("identifier token itself");
    expect(guidance).toContain("resultId is missing or expired");
    expect(event).toEqual({
      ...original,
      systemPromptOptions: {
        ...original.systemPromptOptions,
        sections: { ...original.systemPromptOptions.sections, lsp_integration: guidance },
      },
    });

    const once = structuredClone(event);
    for (let run = 0; run < 3; run++) {
      expect(await handler?.(event, ctx)).toBeUndefined();
      expect(event).toEqual(once);
      const fresh = { ...beforeAgentEvent(), systemPrompt: `Different rendered prompt ${run}` };
      fresh.systemPromptOptions.selectedTools.push(`new_tool_${run}`);
      await handler?.(fresh, ctx);
      expect(fresh.systemPromptOptions.sections.lsp_integration).toBe(guidance);
      expect(fresh.systemPromptOptions.forceSystemPrompt).toBeUndefined();
    }
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });
});

function beforeAgentEvent(): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "Synthetic question",
    systemPrompt: "base",
    systemPromptOptions: {
      cwd: tempProject,
      customPrompt: "base",
      appendSystemPrompt: "Existing appended instructions",
      selectedTools: ["read", "lsp_hover"],
      hiddenTools: [],
      toolSnippets: { lsp_hover: "Read-only hover" },
      toolGuidelines: { lsp_hover: ["Existing tool guidance"] },
      promptGuidelines: ["Existing prompt guidance"],
      sections: { other_extension: "Keep this section" },
      contextFiles: [],
      skills: [],
    },
  };
}

function fakePi(): {
  api: never;
  handlers: Map<string, Handler>;
  commands: Map<string, CommandHandler>;
  tools: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const tools = new Map<string, ToolHandler>();
  return {
    handlers,
    commands,
    tools,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: (name: string, command: CommandHandler) => commands.set(name, command),
      registerTool: (tool: ToolHandler) => tools.set(tool.name, tool),
    } as never,
  };
}

function fakeContext(): FakeContext {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Record<string, string | undefined> = {};
  return {
    cwd: tempProject,
    hasUI: true,
    ui: {
      notifications,
      statuses,
      theme: { fg: (_name: string, text: string) => text },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => {
        statuses[key] = value;
      },
      confirm: async () => true,
    },
  };
}
