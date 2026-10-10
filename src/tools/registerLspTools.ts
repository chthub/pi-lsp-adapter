import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LspError } from "../lsp/errors.js";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";
import {
  failure,
  formatDefinition,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatReferences,
  formatWorkspaceSymbols,
  toLspPosition,
} from "./lspFormat.js";
import { LSP_RESULT_ID_LENGTH, LSP_RESULT_ID_PATTERN } from "./resultCache.js";

export type GetLspToolState = () => LspExtensionState | null;

const FilePathParams = Type.Object({
  filePath: Type.String({ description: "Path to the source file to inspect." }),
});

const positionProperties = {
  filePath: Type.String({ description: "Path to the source file to inspect." }),
  // Pi 1.1.0 converts fractional Type.Integer inputs by truncating them. Number +
  // multipleOf preserves the same integer constraint without silently moving a position.
  line: Type.Number({ minimum: 1, multipleOf: 1, description: "1-based integer line number." }),
  column: Type.Optional(
    Type.Number({
      minimum: 1,
      multipleOf: 1,
      description: "1-based UTF-16 column on the identifier. Provide column OR symbol, exactly one.",
    }),
  ),
  symbol: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      // Provider schema validators may reject JS Unicode property escapes. Keep
      // identifier syntax validation in validateSymbol(), before any LSP request.
      description:
        "Single identifier on this line (not a path/expression). Unique lexical match required; ambiguity fails. Provide symbol OR column.",
    }),
  ),
};
const positionOptions = {
  oneOf: [
    { required: ["column"], not: { required: ["symbol"] } },
    { required: ["symbol"], not: { required: ["column"] } },
  ],
};
const FilePositionParams = Type.Object(positionProperties, positionOptions);
const ReferencesParams = Type.Object(
  {
    ...positionProperties,
    includeDeclaration: Type.Optional(
      Type.Boolean({ description: "Whether to include the symbol declaration in the result." }),
    ),
  },
  positionOptions,
);

const WorkspaceSymbolsParams = Type.Object({
  query: Type.String({ description: "Workspace symbol query string." }),
  serverId: Type.Optional(Type.String({ description: "Optional LSP server id to query, e.g. pyright or vtsls." })),
});

const MoreParams = Type.Object({
  resultId: Type.String({
    description: "Exact cached LSP resultId returned by a previous paginated LSP tool result.",
    pattern: LSP_RESULT_ID_PATTERN,
    minLength: LSP_RESULT_ID_LENGTH,
    maxLength: LSP_RESULT_ID_LENGTH,
  }),
});

export function registerLspTools(pi: ExtensionAPI, getState: GetLspToolState): void {
  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Read a diagnostic snapshot for a file. Reports pending, fresh, stale, or unverified with version evidence; an empty result is not proof that all checks passed.",
    promptSnippet: "Inspect compiler/type/lint diagnostics from configured language servers for a file.",
    promptGuidelines: [
      "Use lsp_diagnostics after reading or editing code when semantic errors, type errors, or language-server diagnostics would help.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_diagnostics", new LspError("LSP extension is not initialized.", "not-initialized"));
      try {
        const result = formatDiagnostics(
          await state.runtimeManager.diagnostics(params.filePath, _signal),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_diagnostics", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_hover",
    label: "LSP Hover",
    description:
      "Get hover/type information using 1-based line plus exactly one of column (UTF-16) or symbol (unique identifier on that line). Failures include recovery feedback.",
    promptSnippet: "Fetch hover/type information using a 1-based line and column or symbol.",
    promptGuidelines: [
      "Use lsp_hover when symbol type, signature, documentation, or inferred information would reduce guesswork. Supply line plus a unique symbol name, or put an explicit column on the identifier token itself.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state) return failure("lsp_hover", new LspError("LSP extension is not initialized.", "not-initialized"));
      try {
        const position = toLspPosition(params);
        const result = formatHover(
          await state.runtimeManager.hover(params.filePath, position.line, position.character),
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_hover", error);
      }
    },
  });

  pi.registerTool<typeof FilePositionParams, unknown>({
    name: "lsp_definition",
    label: "LSP Definition",
    description:
      "Find definitions using 1-based line plus exactly one of column (UTF-16) or symbol (unique identifier on that line). Ambiguity is rejected.",
    promptSnippet: "Jump to definitions using a 1-based line and column or symbol.",
    promptGuidelines: [
      "Use lsp_definition before changing unfamiliar call sites, types, or imported symbols. Supply line plus a unique symbol name, or put an explicit column on the identifier token itself.",
    ],
    parameters: FilePositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_definition", new LspError("LSP extension is not initialized.", "not-initialized"));
      try {
        const position = toLspPosition(params);
        const result = formatDefinition(
          await state.runtimeManager.definition(params.filePath, position.line, position.character),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_definition", error);
      }
    },
  });

  pi.registerTool<typeof ReferencesParams, unknown>({
    name: "lsp_references",
    label: "LSP References",
    description:
      "Find references using 1-based line plus exactly one of column (UTF-16) or symbol (unique identifier on that line). Ambiguity is rejected.",
    promptSnippet: "Find references using a 1-based line and column or symbol.",
    promptGuidelines: [
      "Use lsp_references to assess impact before renames, API changes, or behavior changes. Supply line plus a unique symbol name, or put an explicit column on the identifier token itself; set includeDeclaration when you need the declaration included in the results.",
    ],
    parameters: ReferencesParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_references", new LspError("LSP extension is not initialized.", "not-initialized"));
      try {
        const position = toLspPosition(params);
        const result = formatReferences(
          await state.runtimeManager.references(
            params.filePath,
            position.line,
            position.character,
            params.includeDeclaration ?? false,
          ),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_references", error);
      }
    },
  });

  pi.registerTool<typeof FilePathParams, unknown>({
    name: "lsp_document_symbols",
    label: "LSP Document Symbols",
    description: "List symbols in a source file using its configured language server.",
    promptSnippet: "List functions, classes, variables, and other symbols in a source file.",
    promptGuidelines: [
      "Use lsp_document_symbols to understand a file's semantic structure before broad edits or before reading a large unfamiliar file end-to-end.",
    ],
    parameters: FilePathParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_document_symbols", new LspError("LSP extension is not initialized.", "not-initialized"));
      try {
        const result = formatDocumentSymbols(
          await state.runtimeManager.documentSymbols(params.filePath),
          state.resultCache,
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_document_symbols", error);
      }
    },
  });

  pi.registerTool<typeof WorkspaceSymbolsParams, unknown>({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description:
      "Search symbols across active LSP workspaces. Optionally provide a server id to start/query that server for the current cwd.",
    promptSnippet: "Search workspace symbols by name across active language-server sessions.",
    promptGuidelines: [
      "Use lsp_workspace_symbols to locate definitions or related symbols by name when file paths are unknown. Omit serverId to query active servers only; provide a configured serverId, such as vtsls or pyright, when you want to start/query a specific server for the current cwd.",
    ],
    parameters: WorkspaceSymbolsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (!state)
        return failure("lsp_workspace_symbols", new LspError("LSP extension is not initialized.", "not-initialized"));
      try {
        const result = formatWorkspaceSymbols(
          await state.runtimeManager.workspaceSymbols(params.query, params.serverId),
          state.resultCache,
          { query: params.query },
        );
        refreshStatus(ctx, state);
        return result;
      } catch (error) {
        refreshStatus(ctx, state);
        return failure("lsp_workspace_symbols", error);
      }
    },
  });

  pi.registerTool<typeof MoreParams, unknown>({
    name: "lsp_more",
    label: "LSP More Results",
    description: "Return the next cached page from a previous paginated LSP result.",
    promptSnippet:
      "Fetch the next sequential page for a previous LSP resultId without re-querying the language server.",
    promptGuidelines: [
      "Use lsp_more only when the previous LSP result explicitly says 'More available' and provides a resultId. Cached pages are sequential and may expire after cache eviction or session restart; if a resultId is missing or expired, re-run the original LSP query.",
    ],
    parameters: MoreParams,
    async execute(_toolCallId, params) {
      const state = getState();
      if (!state) return failure("lsp_more", new LspError("LSP extension is not initialized.", "not-initialized"));
      return state.resultCache.next(params.resultId);
    },
  });
}

function refreshStatus(ctx: ExtensionContext | undefined, state: LspExtensionState): void {
  if (ctx) setLspStatusLine(ctx, state);
}
