/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: Integration tests verify literal ${VAR} interpolation syntax — the strings are intentional. */
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

    const result = loadConfig({ configPath: configFile });
    expect(result).toEqual(config);
  });

  it("parses valid YAML config", () => {
    const yamlContent = `mcp:\n  server:\n    transport: stdio\n    command: node\n`;
    const configFile = join(tempDir, "config.yml");
    writeFileSync(configFile, yamlContent);

    const result = loadConfig({ configPath: configFile });
    expect(result).toEqual({ mcp: { server: { transport: "stdio", command: "node" } } });
  });

  it("throws on invalid JSON content", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(configFile, "not valid json {{{");

    expect(() => loadConfig({ configPath: configFile })).toThrow();
  });

  it("throws on schema validation failure", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(configFile, JSON.stringify({ mcp: { BAD: { transport: "stdio" } } }));

    expect(() => loadConfig({ configPath: configFile })).toThrow("Invalid config file");
  });
});

describe("loadConfig — environment variable interpolation", () => {
  let tempDir: string;
  const SCRATCH_VARS = ["DYNMCP_TEST_BIN", "DYNMCP_TEST_TOKEN", "DYNMCP_TEST_HOST"];
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dynmcp-test-"));
    for (const key of SCRATCH_VARS) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalValues.clear();
  });

  it('interpolates ${VAR} from process.env under default mode ("enable")', () => {
    process.env.DYNMCP_TEST_BIN = "node";
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: { server: { transport: "stdio", command: "${DYNMCP_TEST_BIN}" } },
      }),
    );

    const result = loadConfig({ configPath: configFile });
    expect(result.mcp.server).toEqual({ transport: "stdio", command: "node" });
  });

  it("uses ${VAR:-default} when the variable is missing", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: { server: { transport: "stdio", command: "${DYNMCP_TEST_BIN:-node}" } },
      }),
    );

    const result = loadConfig({ configPath: configFile });
    expect(result.mcp.server).toEqual({ transport: "stdio", command: "node" });
  });

  it("throws when a required variable is missing and lists it in the error", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: { server: { transport: "stdio", command: "${DYNMCP_TEST_BIN}" } },
      }),
    );

    expect(() => loadConfig({ configPath: configFile })).toThrow(/DYNMCP_TEST_BIN/);
  });

  it('leaves ${VAR} literal under env mode "disable"', () => {
    process.env.DYNMCP_TEST_BIN = "should-not-be-used";
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        env: "disable",
        mcp: { server: { transport: "stdio", command: "${DYNMCP_TEST_BIN}" } },
      }),
    );

    const result = loadConfig({ configPath: configFile });
    expect(result.mcp.server).toEqual({ transport: "stdio", command: "${DYNMCP_TEST_BIN}" });
  });

  it('loads from a custom .env via envFilePath in "dotenv" mode', () => {
    const envFile = join(tempDir, "custom.env");
    writeFileSync(envFile, "DYNMCP_TEST_BIN=from-dotenv\n");

    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        env: "dotenv",
        mcp: { server: { transport: "stdio", command: "${DYNMCP_TEST_BIN}" } },
      }),
    );

    const result = loadConfig({ configPath: configFile, envFilePath: envFile });
    expect(result.mcp.server).toEqual({ transport: "stdio", command: "from-dotenv" });
  });

  it('rejects --env (envFilePath) combined with env: "disable"', () => {
    const envFile = join(tempDir, "custom.env");
    writeFileSync(envFile, "FOO=bar\n");

    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        env: "disable",
        mcp: { server: { transport: "stdio", command: "node" } },
      }),
    );

    expect(() => loadConfig({ configPath: configFile, envFilePath: envFile })).toThrow(
      /incompatible/,
    );
  });

  it('rejects --env (envFilePath) combined with env: "process"', () => {
    const envFile = join(tempDir, "custom.env");
    writeFileSync(envFile, "FOO=bar\n");

    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        env: "process",
        mcp: { server: { transport: "stdio", command: "node" } },
      }),
    );

    expect(() => loadConfig({ configPath: configFile, envFilePath: envFile })).toThrow(
      /incompatible/,
    );
  });

  it("interpolates partial strings (e.g. headers with Bearer token)", () => {
    process.env.DYNMCP_TEST_TOKEN = "abc123";
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: {
          remote: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${DYNMCP_TEST_TOKEN}" },
          },
        },
      }),
    );

    const result = loadConfig({ configPath: configFile });
    const remote = result.mcp.remote;
    if (remote.transport !== "streamable-http") throw new Error("transport mismatch");
    expect(remote.headers).toEqual({ Authorization: "Bearer abc123" });
  });

  it("preserves the top-level env field through Zod validation", () => {
    const configFile = join(tempDir, "mcp.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        env: "process",
        mcp: { server: { transport: "stdio", command: "node" } },
      }),
    );

    const result = loadConfig({ configPath: configFile });
    expect(result.env).toBe("process");
  });
});
