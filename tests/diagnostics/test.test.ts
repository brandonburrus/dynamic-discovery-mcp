import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "../../src/auth/errors.js";
import { test as runTest } from "../../src/diagnostics/test.js";

// --- Mock setup ---------------------------------------------------------

/**
 * Per-MCP scenario the fake UpstreamClient honors. Tests configure scenarios by
 * name before calling `test()` so the mocked client produces deterministic results
 * without ever opening a real network connection.
 */
type Scenario = {
  failConnect?: Error;
  capabilities?: Record<string, unknown>;
  tools?: { name: string; description: string }[];
  resources?: { uri: string; name: string; description?: string }[];
  templates?: { uriTemplate: string; name: string; description?: string }[];
  prompts?: { name: string; description?: string }[];
  hangConnect?: boolean;
};

const scenarios = new Map<string, Scenario>();
const keychainMemory = new Map<string, string>();

vi.mock("@napi-rs/keyring", () => {
  class FakeEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}
    private get key(): string {
      return `${this.service} ${this.account}`;
    }
    getPassword(): string | null {
      return keychainMemory.get(this.key) ?? null;
    }
    setPassword(value: string): void {
      keychainMemory.set(this.key, value);
    }
    deletePassword(): boolean {
      return keychainMemory.delete(this.key);
    }
  }
  return { Entry: FakeEntry };
});

vi.mock("../../src/proxy/transport-factory.js", () => ({
  createTransport: () => ({}),
}));

vi.mock("../../src/proxy/upstream-client.js", () => {
  class FakeUpstreamClient {
    private readonly mcpName: string;
    constructor(opts: { name: string }) {
      this.mcpName = opts.name;
    }
    async connect(): Promise<void> {
      const scenario = scenarios.get(this.mcpName);
      if (scenario?.hangConnect === true) {
        await new Promise(() => {}); // hang forever — used to test timeouts
      }
      if (scenario?.failConnect !== undefined) {
        throw scenario.failConnect;
      }
    }
    getCapabilities(): Record<string, unknown> | undefined {
      return scenarios.get(this.mcpName)?.capabilities;
    }
    async listTools(): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
      return (scenarios.get(this.mcpName)?.tools ?? []).map(t => ({ ...t, inputSchema: {} }));
    }
    async listResources(): Promise<{ uri: string; name: string; description?: string }[]> {
      return scenarios.get(this.mcpName)?.resources ?? [];
    }
    async listResourceTemplates(): Promise<
      { uriTemplate: string; name: string; description?: string }[]
    > {
      return scenarios.get(this.mcpName)?.templates ?? [];
    }
    async listPrompts(): Promise<{ name: string; description?: string }[]> {
      return scenarios.get(this.mcpName)?.prompts ?? [];
    }
    async disconnect(): Promise<void> {}
  }
  return { UpstreamClient: FakeUpstreamClient };
});

// --- Test helpers -------------------------------------------------------

let tempDir: string;
let writes: string[];

beforeEach(() => {
  scenarios.clear();
  keychainMemory.clear();
  tempDir = mkdtempSync(join(tmpdir(), "dynmcp-test-test-"));
  writes = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(content: object): string {
  const path = join(tempDir, "mcp.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const capture = (chunk: string): void => {
  writes.push(chunk);
};

// --- Tests --------------------------------------------------------------

describe("test (dynmcp test) — single MCP", () => {
  it("returns exit code 0 on a successful probe and prints the full surface", async () => {
    scenarios.set("linear", {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      tools: [
        { name: "create_issue", description: "Create a new issue" },
        { name: "list_issues", description: "List issues" },
      ],
      resources: [{ uri: "linear://projects", name: "projects" }],
      templates: [{ uriTemplate: "linear://issue/{id}", name: "issue" }],
      prompts: [{ name: "write-pr-description", description: "Generate PR description" }],
    });
    const path = writeConfig({
      mcp: { linear: { transport: "streamable-http", url: "https://mcp.linear.app" } },
    });

    const exitCode = await runTest({ mcpName: "linear", configPath: path, write: capture });
    const out = writes.join("");
    expect(exitCode).toBe(0);
    expect(out).toContain('Testing "linear"');
    expect(out).toContain("Connected and initialized");
    expect(out).toContain("Tools (2):");
    expect(out).toContain("create_issue");
    expect(out).toContain("Resources (1):");
    expect(out).toContain("Resource templates (1):");
    expect(out).toContain("Prompts (1):");
    expect(out).toContain("Result: PASS");
  });

  it("omits empty surface sections from text output", async () => {
    scenarios.set("plain", {
      capabilities: { tools: {} },
      tools: [{ name: "only_tool", description: "the only tool" }],
    });
    const path = writeConfig({
      mcp: { plain: { transport: "streamable-http", url: "https://plain.example/mcp" } },
    });

    const exitCode = await runTest({ mcpName: "plain", configPath: path, write: capture });
    const out = writes.join("");
    expect(exitCode).toBe(0);
    expect(out).toContain("Tools (1):");
    expect(out).not.toContain("Resources (");
    expect(out).not.toContain("Prompts (");
  });

  it("returns exit code 1 and a clean auth-required message when login is required", async () => {
    scenarios.set("oauth-missing", {
      failConnect: new AuthRequiredError("oauth-missing"),
    });
    const path = writeConfig({
      mcp: { "oauth-missing": { transport: "streamable-http", url: "https://x.example/mcp" } },
    });

    const exitCode = await runTest({
      mcpName: "oauth-missing",
      configPath: path,
      write: capture,
    });
    const out = writes.join("");
    expect(exitCode).toBe(1);
    expect(out).toContain("Result: FAIL");
    expect(out).toContain("auth required: run `dynmcp login oauth-missing`");
  });

  it("fails with a timeout message when the connect hangs past the deadline", async () => {
    scenarios.set("slow", { hangConnect: true });
    const path = writeConfig({
      mcp: { slow: { transport: "streamable-http", url: "https://slow.example/mcp" } },
    });

    const exitCode = await runTest({
      mcpName: "slow",
      configPath: path,
      write: capture,
      timeoutMs: 50,
    });
    const out = writes.join("");
    expect(exitCode).toBe(1);
    expect(out).toContain("Result: FAIL");
    expect(out).toMatch(/timed out after \d+ms/i);
  });

  it("throws a clear error for an unknown MCP name", async () => {
    const path = writeConfig({
      mcp: { known: { transport: "streamable-http", url: "https://k.example/mcp" } },
    });

    await expect(runTest({ mcpName: "missing", configPath: path, write: capture })).rejects.toThrow(
      /Unknown MCP "missing"/,
    );
  });

  it("emits structured JSON when --json is set", async () => {
    scenarios.set("linear", {
      capabilities: { tools: {} },
      tools: [{ name: "t1", description: "d1" }],
    });
    const path = writeConfig({
      mcp: { linear: { transport: "streamable-http", url: "https://mcp.linear.app" } },
    });

    const exitCode = await runTest({
      mcpName: "linear",
      configPath: path,
      write: capture,
      json: true,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(writes.join("")) as {
      name: string;
      result: string;
      tools: unknown[];
    };
    expect(parsed.name).toBe("linear");
    expect(parsed.result).toBe("PASS");
    expect(parsed.tools).toHaveLength(1);
  });
});

describe("test (dynmcp test) — all MCPs", () => {
  it("tests every configured MCP sequentially and reports a summary", async () => {
    scenarios.set("good", {
      capabilities: { tools: {} },
      tools: [{ name: "a", description: "" }],
    });
    scenarios.set("bad", {
      failConnect: new AuthRequiredError("bad"),
    });
    const path = writeConfig({
      mcp: {
        good: { transport: "streamable-http", url: "https://good.example/mcp" },
        bad: { transport: "streamable-http", url: "https://bad.example/mcp" },
      },
    });

    const exitCode = await runTest({ configPath: path, write: capture });
    const out = writes.join("");
    expect(exitCode).toBe(1);
    expect(out).toContain("Testing all configured upstreams (2)");
    expect(out).toContain("good (streamable-http) ... PASS");
    expect(out).toContain("bad (streamable-http) ... FAIL");
    expect(out).toContain("auth required");
    expect(out).toContain("Summary: 1 passed, 1 failed");
  });

  it("returns exit code 0 when every MCP passes", async () => {
    scenarios.set("only", {
      capabilities: { tools: {} },
      tools: [],
    });
    const path = writeConfig({
      mcp: { only: { transport: "streamable-http", url: "https://only.example/mcp" } },
    });

    const exitCode = await runTest({ configPath: path, write: capture });
    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Summary: 1 passed, 0 failed");
  });

  it("emits structured JSON with summary when --json is set", async () => {
    scenarios.set("a", { capabilities: { tools: {} }, tools: [] });
    scenarios.set("b", { failConnect: new Error("boom") });
    const path = writeConfig({
      mcp: {
        a: { transport: "streamable-http", url: "https://a.example/mcp" },
        b: { transport: "streamable-http", url: "https://b.example/mcp" },
      },
    });

    const exitCode = await runTest({ configPath: path, write: capture, json: true });
    const parsed = JSON.parse(writes.join("")) as {
      summary: { passed: number; failed: number };
      results: unknown[];
    };
    expect(exitCode).toBe(1);
    expect(parsed.summary).toEqual({ passed: 1, failed: 1 });
    expect(parsed.results).toHaveLength(2);
  });
});
