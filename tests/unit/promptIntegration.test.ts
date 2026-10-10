import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  VERSION,
  type BuildSystemPromptOptions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import {
  getCurrentSystemPrompt,
  getToolStateChanges,
  resolveTranscriptTools,
} from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";

// Exercise the real Pi 1.1.0 methods without constructing a session or calling a provider.
// Keep private-method access confined to this regression test, not extension code.
interface ProjectionFixture {
  agent: {
    transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;
  };
  _runSystemPromptOptions?: BuildSystemPromptOptions;
  _hiddenDeclarations: Set<string>;
  _applyToolLoadout: (names: string[] | undefined) => Tool[];
}
const methods = AgentSession.prototype as unknown as {
  _installAgentForcedPromptProjection: (this: ProjectionFixture) => void;
  _preparePromptAndToolLoadout: (
    this: ProjectionFixture,
    options: BuildSystemPromptOptions,
    messages: Message[],
  ) => SystemMessage | undefined;
};

let originalHome: string | undefined;
let home: string;
let cwd: string;
let runner: ExtensionRunner | undefined;
let errors: unknown[];

beforeEach(async () => {
  originalHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "pi-lsp-prompt-home-"));
  cwd = await mkdtemp(join(tmpdir(), "pi-lsp-prompt-project-"));
  process.env.HOME = home;
  errors = [];
});

afterEach(async () => {
  try {
    await runner?.emit({ type: "session_shutdown", reason: "quit" });
    expect(errors).toEqual([]);
  } finally {
    runner = undefined;
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

async function initializedRunner(): Promise<ExtensionRunner> {
  expect(VERSION).toBe("1.1.0");
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  // Isolated agent directory: never discover the installed npm copy or personal extensions.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: home,
    additionalExtensionPaths: [packageRoot],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  expect(loaded.warnings ?? []).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect([...loaded.extensions[0]!.tools.keys()].sort()).toEqual([
    "lsp_definition",
    "lsp_diagnostics",
    "lsp_document_symbols",
    "lsp_hover",
    "lsp_more",
    "lsp_references",
    "lsp_workspace_symbols",
  ]);
  runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), {} as never);
  runner.onError((error) => errors.push(error));
  const statuses: Record<string, string | undefined> = {};
  vi.spyOn(runner, "createContext").mockReturnValue({
    cwd,
    hasUI: false,
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      setStatus: (key: string, value: string | undefined) => {
        statuses[key] = value;
      },
    },
  } as unknown as ExtensionContext);
  await runner.emit({ type: "session_start", reason: "startup" });
  expect(errors).toEqual([]);
  expect(statuses.lsp).toMatch(/LSP: 0\/\d+ servers/u);
  return runner;
}

const tool = (name: string): Tool => ({ name, description: `Synthetic ${name}`, parameters: Type.Object({}) });

async function enabledHistory() {
  const activeRunner = await initializedRunner();
  const initialTools = Array.from({ length: 14 }, (_, index) => tool(`base_${index}`));
  const addedTools = ["web_search", "source_check", "fetch_content", "get_search_content"].map(tool);
  const tools = [...initialTools, ...addedTools];
  const options: BuildSystemPromptOptions = {
    cwd,
    appendSystemPrompt: "Synthetic leading instructions",
    selectedTools: initialTools.map((item) => item.name),
    toolSnippets: Object.fromEntries(tools.map((item) => [item.name, item.description])),
    contextFiles: [],
    skills: [],
    sections: { other_extension: "Existing guidance" },
  };
  const first = await activeRunner.emitBeforeAgentStart("First question", undefined, options);
  expect(first.systemPromptOptions.forceSystemPrompt).toBeUndefined();
  expect(first.systemPromptOptions.sections.lsp_integration).toContain("read-only LSP tools");
  expect(first.systemPromptOptions.sections.other_extension).toBe("Existing guidance");
  const fixture: ProjectionFixture = {
    agent: {},
    _runSystemPromptOptions: first.systemPromptOptions,
    _hiddenDeclarations: new Set(),
    _applyToolLoadout: (names) => tools.filter((item) => names?.includes(item.name)),
  };
  const initialPatch = methods._preparePromptAndToolLoadout.call(fixture, first.systemPromptOptions, []);
  expect(initialPatch).toBeDefined();
  const initial: SystemMessage = { ...initialPatch!, toolsAdded: initialTools, timestamp: 0 };
  const history: Message[] = [initial, { role: "user", content: "First question", timestamp: 1 }];
  const originalPrefix = structuredClone(history);
  const leadingInstructions = getCurrentSystemPrompt([initial]);

  const next = await activeRunner.emitBeforeAgentStart("Enable web tools", undefined, {
    ...options,
    selectedTools: tools.map((item) => item.name),
  });
  expect(next.systemPromptOptions.forceSystemPrompt).toBeUndefined();
  expect(next.systemPromptOptions.sections.lsp_integration).toBe(first.systemPromptOptions.sections.lsp_integration);
  fixture._runSystemPromptOptions = next.systemPromptOptions;
  const update = methods._preparePromptAndToolLoadout.call(fixture, next.systemPromptOptions, history);
  expect(update).toBeDefined();
  expect(update?.sections).not.toHaveProperty("lsp_integration");
  expect(update?.sections?.tools).toContain("web_search");
  expect(initial.sections?.tools).not.toContain("web_search");
  // Simulate enable using Pi's tool-state diff, leaving the committed history in place.
  const changes = getToolStateChanges(initialTools, tools);
  expect(changes.toolsAdded).toEqual(addedTools);
  expect(changes.toolsRemoved).toEqual([]);
  history.push({ ...update!, toolsAdded: changes.toolsAdded, timestamp: 2 });
  history.push({ role: "user", content: "Next question", timestamp: 3 });
  const originalHistory = structuredClone(history);
  methods._installAgentForcedPromptProjection.call(fixture);
  const projected = await fixture.agent.transformContext!(history);
  expect(projected).toBe(history);
  expect(history).toEqual(originalHistory);
  expect(history.slice(0, 2)).toEqual(originalPrefix);
  expect(getCurrentSystemPrompt([projected[0]!])).toBe(leadingInstructions);
  expect(projected.filter((message) => message.role === "system")).toHaveLength(2);
  return { history, projected, fixture, initialTools, addedTools, leadingInstructions };
}

describe("Pi prompt/tool delta integration (offline)", () => {
  it("loads initialized LSP through Pi and preserves additive tools and leading instructions", async () => {
    const { projected, initialTools, addedTools } = await enabledHistory();
    const transport = resolveTranscriptTools(projected, true);
    expect(transport.requestTools).toEqual(initialTools);
    expect(transport.anchorsAdditions).toBe(true);
    expect((projected[2] as SystemMessage).toolsAdded).toEqual(addedTools);
  });

  it("keeps unsupported-additions fallback as an independent expected branch", async () => {
    const { projected, initialTools, addedTools } = await enabledHistory();
    const fallback = resolveTranscriptTools(projected, false);
    expect(fallback.requestTools).toEqual([...initialTools, ...addedTools]);
    expect(fallback.anchorsAdditions).toBe(false);
    expect(projected.filter((message) => message.role === "system")).toHaveLength(2);
  });

  it("detects the old forced-prompt collapse as a positive control", async () => {
    const { history, fixture, leadingInstructions } = await enabledHistory();
    fixture._runSystemPromptOptions = { cwd, forceSystemPrompt: leadingInstructions };
    const projected = await fixture.agent.transformContext!(history);
    expect(projected.filter((message) => message.role === "system")).toHaveLength(1);
    expect((projected[0] as SystemMessage).content).toBe(leadingInstructions);
    expect(resolveTranscriptTools(projected, true).requestTools).toHaveLength(18);
    expect(history.filter((message) => message.role === "system")).toHaveLength(2);
  });
});
