import { describe, expect, it } from "vitest";
import { resolveSymbol, validateSymbol, MAX_SYMBOL_CANDIDATES } from "../../src/lsp/positionSelector.js";
import { toLspPosition } from "../../src/tools/lspFormat.js";

describe("line + symbol lexical selectors", () => {
  it.each([
    ["outfit fit fitting", "fit", 7],
    ["$fit fit _fit", "$fit", 0],
    ["$fit fit _fit", "_fit", 9],
    ["变量 拟合(data)", "拟合", 3],
    ["\t😀 中文 fit(data)", "fit", 7],
    ["𐐀name()", "𐐀name", 0],
  ])("resolves %j symbol %j at UTF-16 offset %i", (text, symbol, offset) => {
    expect(resolveSymbol(text, "a.ts", 0, symbol)).toBe(offset);
  });
  it.each(["outfit fitting", "$fit _fit fit2", "éfit fit中文", "1fit", "\u0301fit"])(
    "does not match subwords: %j",
    (text) => {
      expect(() => resolveSymbol(text, "a.ts", 0, "fit")).toThrow(
        expect.objectContaining({ code: "symbol-not-found" }),
      );
    },
  );
  it("refuses comments/strings ambiguity and reports accurate bounded candidates", () => {
    expect(() => resolveSymbol("fit(); // fit()", "a.ts", 0, "fit")).toThrow(
      expect.objectContaining({
        code: "ambiguous-symbol",
        payload: expect.objectContaining({
          candidates: [
            { line: 1, column: 1 },
            { line: 1, column: 11 },
          ],
        }),
      }),
    );
    try {
      resolveSymbol("fit ".repeat(1000), "a.ts", 0, "fit");
    } catch (error) {
      expect(error).toMatchObject({ code: "ambiguous-symbol", payload: { candidatesTruncated: true } });
      expect((error as { payload: { candidates: unknown[] } }).payload.candidates).toHaveLength(MAX_SYMBOL_CANDIDATES);
    }
  });
  it.each(["", "fit()", "obj.fit", "fit\n", "fit x", ".*", "1fit", "x".repeat(257)])(
    "rejects non-identifiers: %j",
    (symbol) => {
      expect(() => validateSymbol(symbol)).toThrow(expect.objectContaining({ code: "invalid-selector" }));
    },
  );
  it("uses Unicode character counts for the symbol-length schema limit, not coordinate units", () => {
    expect(() => validateSymbol("𐐀".repeat(256))).not.toThrow();
    expect(() => validateSymbol("𐐀".repeat(257))).toThrow(expect.objectContaining({ code: "invalid-selector" }));
  });
  it("enforces exactly one selector without clamping coordinates", () => {
    expect(() => toLspPosition({ line: 1 })).toThrow(expect.objectContaining({ code: "invalid-selector" }));
    expect(() => toLspPosition({ line: 1, column: 1, symbol: "fit" })).toThrow(
      expect.objectContaining({ code: "invalid-selector" }),
    );
    expect(toLspPosition({ line: 2, symbol: "fit" })).toEqual({ line: 1, character: "fit" });
    expect(toLspPosition({ line: -1, column: 1.5 })).toEqual({ line: -2, character: 0.5 });
  });
});
