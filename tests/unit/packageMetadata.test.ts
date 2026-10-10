import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
const hostPackages = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

describe("Pi package metadata", () => {
  it.each(hostPackages)("declares %s as a wildcard peer, never a runtime dependency", (name) => {
    expect(manifest.peerDependencies[name]).toBe("*");
    expect(manifest.dependencies).not.toHaveProperty(name);
    expect(lock.packages[""].peerDependencies[name]).toBe("*");
    expect(lock.packages[""].dependencies).not.toHaveProperty(name);
    expect(lock.packages[`node_modules/${name}`].dev).toBe(true);
  });

  it("locks the development SDK to the tested Pi 1.1.0 API", () => {
    for (const name of hostPackages.filter((name) => name.startsWith("@earendil-works/"))) {
      expect(manifest.devDependencies[name]).toBe("1.1.0");
      expect(lock.packages[`node_modules/${name}`].version).toBe("1.1.0");
    }
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
    expect(lock.packages[""].peerDependencies).toEqual(manifest.peerDependencies);
    expect(lock.packages[""].peerDependenciesMeta).toEqual(manifest.peerDependenciesMeta);
    expect(manifest).not.toHaveProperty("bundledDependencies");
    expect(manifest).not.toHaveProperty("bundleDependencies");
    expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
  });

  it("prevents this fork from publishing the upstream npm name", () => {
    expect(manifest.private).toBe(true);
    const workflow = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    expect(workflow).toContain("github.repository == 'nikmmd/pi-lsp-adapter' &&");
  });
});
