import { describe, expect, it } from "vitest";
import { LspError, errorRecovery, fileReadError } from "../../src/lsp/errors.js";
import { sourceContext, splitLines, SOURCE_CONTEXT_MAX_BYTES } from "../../src/lsp/sourceContext.js";
import { failure } from "../../src/tools/lspFormat.js";
import { LspResultCache } from "../../src/tools/resultCache.js";

describe("bounded failure feedback", () => {
  it("shows all five real lines and preserves empty source lines", () => {
    const text =
      "def predict(data):\n    prepared = normalize(data)\n    result = fit(prepared)\n\n    return result\n";
    const context = sourceContext(text, 2);
    const result = failure(
      "lsp_definition",
      new LspError("Column 40 is outside the line.", "invalid-position", {
        context,
        requestedPosition: { line: 3, column: 40 },
        fileLineCount: 6,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ ok: false, category: "invalid-position", retryable: false });
    for (const [index, line] of splitLines(text).slice(0, 5).entries()) {
      expect(result.content[0].text).toContain(`${index + 1} | ${line}`);
    }
    expect(result.content[0].text).toContain("Locate the intended symbol");
  });

  it.each(["\n", "\r\n", "\r"])("counts %j consistently and reports the actual file end", (newline) => {
    const context = sourceContext(["a", "b", "c", "d", "e", "f", ""].join(newline), 99);
    expect(context).toMatchObject({ startLine: 3, endLine: 7, kind: "file-end", truncated: false });
    expect(context.text).toBe("3 | c\n4 | d\n5 | e\n6 | f\n7 | ");
    expect(
      failure("lsp_hover", new LspError("Invalid line", "invalid-position", { context })).content[0].text,
    ).toContain("Requested line does not exist; below is the file end");
  });

  it("handles empty files and invalid line numbers without clamping", () => {
    expect(splitLines("")).toEqual([""]);
    expect(sourceContext("", 0).text).toBe("1 | ");
    expect(sourceContext("", 1).kind).toBe("file-end");
    expect(sourceContext("x", -1).kind).toBe("file-start");
    expect(sourceContext("x", 0.5).kind).toBe("file-start");
  });

  it("bounds long Unicode source without splitting surrogate pairs", () => {
    const context = sourceContext(Array.from({ length: 1000 }, () => "😀中文".repeat(1000)).join("\n"), 500);
    expect(context.truncated).toBe(true);
    expect(context.text).toContain("[line truncated]");
    expect(Buffer.byteLength(context.text)).toBeLessThanOrEqual(SOURCE_CONTEXT_MAX_BYTES);
    expect(Buffer.from(context.text).toString("utf8")).toBe(context.text);
    expect(context).toMatchObject({ startLine: 499, endLine: 503 });
  });

  it("does not infer unknown categories from exception text", () => {
    const result = failure("lsp_hover", new Error("vtsls timed out after 10ms.\nSECRET STACK"));
    expect(result.details.category).toBe("unknown");
    expect(result.content[0].text).not.toContain("SECRET STACK");
    expect(errorRecovery("timeout").retryable).toBe(true);
    expect(errorRecovery("not-installed").retryable).toBe(false);
    expect(failure("lsp_hover", new LspError("Timeout", "timeout")).details.category).toBe("timeout");
  });

  it("classifies filesystem failures by errno without disclosing exception internals", () => {
    expect(fileReadError({ code: "EACCES", message: "SECRET" }, "a.ts")).toMatchObject({ code: "permission-denied" });
    expect(fileReadError({ code: "ENOENT" }, "a.ts")).toMatchObject({ code: "file-not-found" });
    const unknown = failure("lsp_hover", fileReadError({ message: "SECRET", env: "TOKEN" }, "a.ts"));
    expect(unknown.details.category).toBe("unknown");
    expect(unknown.content[0].text).not.toContain("SECRET");
    expect(unknown.content[0].text).not.toContain("TOKEN");
  });

  it("marks invalid and expired pagination IDs, but not completion", () => {
    const cache = new LspResultCache();
    expect(cache.next("invalid").isError).toBe(true);
    const id = cache.store({
      label: "synthetic",
      pages: [
        { text: "1", details: {} },
        { text: "2", details: {} },
      ],
    })!;
    expect(cache.next(id).isError).not.toBe(true);
    expect(cache.next(id).isError).not.toBe(true);
    expect(cache.next(id).isError).toBe(true);
  });
});
