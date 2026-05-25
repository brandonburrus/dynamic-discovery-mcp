import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../../src/scaffold/init.js";

let tempDir: string;
let writes: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dynmcp-init-test-"));
  writes = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const capture = (chunk: string): void => {
  writes.push(chunk);
};

describe("init (dynmcp init)", () => {
  it("writes mcp.json with $schema and empty mcp by default", () => {
    init({ cwd: tempDir, write: capture });
    const target = join(tempDir, "mcp.json");
    expect(existsSync(target)).toBe(true);
    const content = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
    expect(content).toEqual({
      $schema: "https://dynamicmcp.tools/config.json",
      mcp: {},
    });
  });

  it("writes mcp.yaml when --yaml is set", () => {
    init({ cwd: tempDir, yaml: true, write: capture });
    const target = join(tempDir, "mcp.yaml");
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain(
      "# yaml-language-server: $schema=https://dynamicmcp.tools/config.json",
    );
    expect(content).toContain("mcp: {}");
  });

  it("uses .yaml extension from --path even if --yaml is not set", () => {
    const path = join(tempDir, "custom.yaml");
    init({ path, write: capture });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("mcp: {}");
  });

  it("treats --path with .json extension as JSON even if --yaml is set", () => {
    const path = join(tempDir, "custom.json");
    init({ path, yaml: true, write: capture });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcp: Record<string, unknown> };
    expect(parsed.mcp).toEqual({});
  });

  it("refuses to overwrite an existing file without --force", () => {
    init({ cwd: tempDir, write: capture });
    expect(() => init({ cwd: tempDir, write: capture })).toThrow(/already exists/);
  });

  it("overwrites an existing file with --force", () => {
    init({ cwd: tempDir, write: capture });
    expect(() => init({ cwd: tempDir, force: true, write: capture })).not.toThrow();
  });

  it("prints a next-step hint pointing at dynmcp add", () => {
    init({ cwd: tempDir, write: capture });
    const out = writes.join("");
    expect(out).toContain("dynmcp add");
  });

  it("prints the written path", () => {
    init({ cwd: tempDir, write: capture });
    const out = writes.join("");
    expect(out).toContain(join(tempDir, "mcp.json"));
  });

  it("resolves --path relative to cwd", () => {
    init({ cwd: tempDir, path: "nested.json", write: capture });
    expect(existsSync(join(tempDir, "nested.json"))).toBe(true);
  });
});
