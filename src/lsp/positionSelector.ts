import { LspError } from "./errors.js";
import { sourceContext, splitLines } from "./sourceContext.js";

export const MAX_SYMBOL_LENGTH = 256;
export const MAX_SYMBOL_CANDIDATES = 32;
const IDENTIFIER = /^[$_\p{ID_Start}][$\p{ID_Continue}\u200c\u200d]*$/u;
// Include identifier continuations (and digits) in the entire run: a subword is never a candidate.
const IDENTIFIER_RUN = /[$_\p{ID_Continue}\u200c\u200d]+/gu;

export function validateSymbol(symbol: string): void {
  if ([...symbol].length > MAX_SYMBOL_LENGTH || !IDENTIFIER.test(symbol)) {
    throw new LspError(
      "symbol must be one nonempty identifier (at most 256 Unicode characters), not an expression, path, or regular expression.",
      "invalid-selector",
    );
  }
}

export function resolveSymbol(text: string, filePath: string, line: number, symbol: string): number {
  validateSymbol(symbol);
  const sourceLine = splitLines(text)[line]!;
  const candidates: Array<{ line: number; column: number }> = [];
  let total = 0;
  for (const match of sourceLine.matchAll(IDENTIFIER_RUN)) {
    if (match[0] !== symbol) continue;
    total++;
    if (candidates.length < MAX_SYMBOL_CANDIDATES) candidates.push({ line: line + 1, column: match.index + 1 });
  }
  if (total === 1) return candidates[0]!.column - 1;
  throw new LspError(
    total
      ? "The symbol has multiple lexical candidates on this line."
      : "The symbol was not found as a complete identifier on this line.",
    total ? "ambiguous-symbol" : "symbol-not-found",
    {
      filePath,
      requestedPosition: { line: line + 1, symbol },
      fileLineCount: splitLines(text).length,
      context: sourceContext(text, line),
      ...(total ? { candidates, candidatesTruncated: total > candidates.length } : {}),
    },
  );
}
