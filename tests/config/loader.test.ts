import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resolveConfigPath } from "../../src/config/loader.js";

describe("resolveConfigPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dynmcp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns resolved absolute path for explicit path", () => {
    const configFile = join(tempDir, "custom.json");
    writeFileSync(configFile, "{}");

    const result = resolveConfigPath(configFile);
    expect(result).toBe(configFile);
  });

  it("throws for nonexistent explicit path", () => {
    expect(() => resolveConfigPath(join(tempDir, "nope.json"))).toThrow("Config file not found");
  });

  it("auto-discovers mcp.json in cwd", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(configFile, "{}");
    vi.spyOn(process, "cwd").mockReturnValue(tempDir);

    const result = resolveConfigPath();
    expect(result).toBe(configFile);
  });

  it("throws when no config file is found via auto-discovery", () => {
    vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    expect(() => resolveConfigPath()).toThrow("No config file found");
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dynmcp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses valid JSON config", () => {
    const config = { mcp: { server: { transport: "stdio", command: "node" } } };
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(configFile, JSON.stringify(config));

    const result = loadConfig(configFile);
    expect(result).toEqual(config);
  });

  it("parses valid YAML config", () => {
    const yamlContent = `mcp:\n  server:\n    transport: stdio\n    command: node\n`;
    const configFile = join(tempDir, "config.yml");
    writeFileSync(configFile, yamlContent);

    const result = loadConfig(configFile);
    expect(result).toEqual({ mcp: { server: { transport: "stdio", command: "node" } } });
  });

  it("throws on invalid JSON content", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(configFile, "not valid json {{{");

    expect(() => loadConfig(configFile)).toThrow();
  });

  it("throws on schema validation failure", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(configFile, JSON.stringify({ mcp: { BAD: { transport: "stdio" } } }));

    expect(() => loadConfig(configFile)).toThrow("Invalid config file");
  });
});
