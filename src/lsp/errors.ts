import type { SourceContext } from "./sourceContext.js";

export type LspErrorCode =
  | "not-initialized"
  | "no-filetype"
  | "no-server"
  | "not-installed"
  | "declined"
  | "start-failed"
  | "outside-workspace"
  | "file-not-found"
  | "permission-denied"
  | "invalid-position"
  | "invalid-selector"
  | "ambiguous-symbol"
  | "symbol-not-found"
  | "timeout"
  | "unsupported-capability"
  | "cancelled"
  | "server-exited"
  | "shutdown"
  | "invalid-result-id"
  | "expired-result-id"
  | "unknown";

export interface LspErrorPayload {
  filePath?: string;
  requestedPosition?: { line: number; column?: number; symbol?: string };
  fileLineCount?: number;
  validColumnRange?: { minimum: number; maximum: number };
  context?: SourceContext;
  candidates?: Array<{ line: number; column: number }>;
  candidatesTruncated?: boolean;
}

export class LspError extends Error {
  constructor(
    message: string,
    readonly code: LspErrorCode,
    readonly payload?: LspErrorPayload,
  ) {
    super(message);
    this.name = "LspError";
  }
}

const RECOVERY: Partial<Record<LspErrorCode, string>> = {
  "not-initialized": "Start an initialized LSP extension session before querying.",
  "no-filetype": "Use a supported source file path.",
  "no-server": "Configure a language server for this filetype or select a configured server.",
  "not-installed": "Install the named server explicitly with /lsp install <serverId>, then query again.",
  declined: "Install the server explicitly if desired; do not repeat the unchanged query expecting installation.",
  "start-failed": "Check the server configuration and /lsp doctor before trying again.",
  "outside-workspace": "Use a file under the current workspace; no source context is available.",
  "file-not-found": "Check filePath and try again after correcting it or creating the file.",
  "permission-denied": "Obtain file access permission before querying again.",
  "invalid-position": "Locate the intended symbol in this source before retrying with valid 1-based coordinates.",
  "invalid-selector": "Provide line and exactly one of column or a single identifier symbol.",
  "ambiguous-symbol": "Choose the intended candidate and retry using its explicit column; no candidate was selected.",
  "symbol-not-found": "Locate the intended symbol in this line before retrying; no cross-line search was performed.",
  timeout: "Retry the request later, or run /lsp restart if the language server stays stuck.",
  "unsupported-capability": "Try a different LSP tool or server for this file.",
  cancelled: "Start a new query if still needed; the cancelled operation will not retry automatically.",
  "server-exited": "Check /lsp status or /lsp doctor; a new query can start a replacement server.",
  shutdown: "Query again in an active session after shutdown or replacement completes.",
  "invalid-result-id": "Use the exact resultId from a previous paginated LSP result.",
  "expired-result-id": "Re-run the original LSP query to get a fresh resultId.",
};

export function errorRecovery(code: LspErrorCode): { retryable: boolean; recovery: string } {
  return {
    retryable: code === "timeout" || code === "server-exited",
    recovery: RECOVERY[code] ?? "Inspect the reported failure before retrying; no automatic recovery was attempted.",
  };
}

export function fileReadError(error: unknown, filePath: string): LspError {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new LspError(`File not found: ${filePath}.`, "file-not-found");
  if (code === "EACCES" || code === "EPERM")
    return new LspError(`Permission denied reading ${filePath}.`, "permission-denied");
  return new LspError(`Could not read source file ${filePath}.`, "unknown");
}
