export const SOURCE_CONTEXT_MAX_BYTES = 2048;
export const SOURCE_LINE_MAX_BYTES = 320;

export interface SourceContext {
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
  kind: "target" | "file-end" | "file-start";
}

// LSP UTF-16 positions include the final empty line, including in an empty document.
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

export function truncateUtf8(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function sourceContext(text: string, line: number): SourceContext {
  const lines = splitLines(text);
  const validLine = Number.isInteger(line) && line >= 0 && line < lines.length;
  const pastEnd = Number.isInteger(line) && line >= lines.length;
  const start = validLine ? Math.max(0, line - 2) : pastEnd ? Math.max(0, lines.length - 5) : 0;
  const end = validLine ? Math.min(lines.length, line + 3) : Math.min(lines.length, start + 5);
  let truncated = false;
  const output: string[] = [];
  for (let index = start; index < end; index++) {
    const original = lines[index]!;
    const shortened = truncateUtf8(original, SOURCE_LINE_MAX_BYTES);
    const cut = shortened.length !== original.length;
    truncated ||= cut;
    output.push(`${index + 1} | ${shortened}${cut ? " [line truncated]" : ""}`);
  }
  const joined = output.join("\n");
  const bounded = truncateUtf8(joined, SOURCE_CONTEXT_MAX_BYTES - 32);
  truncated ||= bounded.length !== joined.length;
  return {
    startLine: start + 1,
    endLine: end,
    text: bounded + (bounded.length !== joined.length ? "\n[context truncated]" : ""),
    truncated,
    kind: validLine ? "target" : pastEnd ? "file-end" : "file-start",
  };
}
