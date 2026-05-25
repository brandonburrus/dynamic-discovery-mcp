import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { add } from "../../src/scaffold/add.js";

let tempDir: string;
let writes: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dynmcp-add-test-"));
  writes = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const capture = (chunk: string): void => {
  writes.push(chunk);
};

function writeConfig(filename: string, content: string): string {
  const path = join(tempDir, filename);
  writeFileSync(path, content);
  return path;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("add (dynmcp add)", () => {
  describe("stdio transport", () => {
    it("adds a basic stdio entry with command and args", () => {
      const path = writeConfig(
        "mcp.json",
        JSON.stringify({ $schema: "https://dynamicmcp.tools/config.json", mcp: {} }),
      );
      add({
        name: "filesystem",
        transport: "stdio",
        configPath: path,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        write: capture,
      });
      const out = readJson(path);
      const mcp = out.mcp as Record<string, unknown>;
      expect(mcp.filesystem).toEqual({
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      });
    });

    it("requires --command for stdio", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({ name: "x", transport: "stdio", configPath: path, write: capture }),
      ).toThrow(/--command is required/);
    });

    it("parses --env KEY=VAL pairs into the env object", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "x",
        transport: "stdio",
        configPath: path,
        command: "node",
        envVars: ["FOO=bar", "BAZ=qux"],
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, { env: Record<string, string> }>;
      expect(mcp.x?.env).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("rejects malformed --env (no equals sign)", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "x",
          transport: "stdio",
          configPath: path,
          command: "node",
          envVars: ["NOPE"],
          write: capture,
        }),
      ).toThrow(/KEY=VALUE/);
    });

    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: testing that literal ${VAR} syntax round-trips
    it("preserves literal ${VAR} interpolation references", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "x",
        transport: "stdio",
        configPath: path,
        command: "node",
        envVars: ["TOKEN=${MY_TOKEN}"],
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, { env: Record<string, string> }>;
      expect(mcp.x?.env.TOKEN).toBe("${MY_TOKEN}");
    });
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: testing that literal ${VAR} syntax round-trips

    it("omits args when none provided", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "x",
        transport: "stdio",
        configPath: path,
        command: "node",
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, Record<string, unknown>>;
      expect(mcp.x).toEqual({ transport: "stdio", command: "node" });
    });
  });

  describe("streamable-http transport", () => {
    it("adds an entry with a URL", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "github",
        transport: "streamable-http",
        configPath: path,
        url: "https://api.githubcopilot.com/mcp",
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, unknown>;
      expect(mcp.github).toEqual({
        transport: "streamable-http",
        url: "https://api.githubcopilot.com/mcp",
      });
    });

    it("requires --url for streamable-http", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "x",
          transport: "streamable-http",
          configPath: path,
          write: capture,
        }),
      ).toThrow(/--url is required/);
    });

    it("parses --header pairs and trims surrounding whitespace", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "api",
        transport: "streamable-http",
        configPath: path,
        url: "https://api.example.com/mcp",
        headers: ["Authorization: Bearer abc", "X-Custom:  value  "],
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, { headers: Record<string, string> }>;
      expect(mcp.api?.headers).toEqual({
        Authorization: "Bearer abc",
        "X-Custom": "value",
      });
    });

    it("rejects --header without a colon", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "api",
          transport: "streamable-http",
          configPath: path,
          url: "https://api.example.com/mcp",
          headers: ["BadHeader"],
          write: capture,
        }),
      ).toThrow(/Name: Value/);
    });

    it("writes the auth block when --client-id is provided", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "api",
        transport: "streamable-http",
        configPath: path,
        url: "https://api.example.com/mcp",
        clientId: "abc",
        clientSecret: "secret",
        scope: "read write",
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, { auth: Record<string, string> }>;
      expect(mcp.api?.auth).toEqual({
        client_id: "abc",
        client_secret: "secret",
        scope: "read write",
      });
    });

    it("requires --client-id when --client-secret is provided", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "api",
          transport: "streamable-http",
          configPath: path,
          url: "https://api.example.com/mcp",
          clientSecret: "secret",
          write: capture,
        }),
      ).toThrow(/--client-id is required/);
    });

    it("requires --client-id when --scope is provided", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "api",
          transport: "streamable-http",
          configPath: path,
          url: "https://api.example.com/mcp",
          scope: "read",
          write: capture,
        }),
      ).toThrow(/--client-id is required/);
    });
  });

  describe("sse transport", () => {
    it("adds an sse entry with a URL", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "events",
        transport: "sse",
        configPath: path,
        url: "https://events.example.com/mcp",
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, unknown>;
      expect(mcp.events).toEqual({
        transport: "sse",
        url: "https://events.example.com/mcp",
      });
    });
  });

  describe("validation", () => {
    it("rejects an invalid MCP name", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "Bad_Name",
          transport: "stdio",
          configPath: path,
          command: "x",
          write: capture,
        }),
      ).toThrow(/Invalid MCP name/);
    });

    it("rejects an MCP name starting with a dash", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "-bad",
          transport: "stdio",
          configPath: path,
          command: "x",
          write: capture,
        }),
      ).toThrow(/Invalid MCP name/);
    });

    it("rejects a non-http URL via the transport schema", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      expect(() =>
        add({
          name: "x",
          transport: "streamable-http",
          configPath: path,
          url: "ftp://nope.example.com",
          write: capture,
        }),
      ).toThrow();
    });

    it("refuses to overwrite an existing entry without --force", () => {
      const path = writeConfig(
        "mcp.json",
        JSON.stringify({ mcp: { dup: { transport: "stdio", command: "echo" } } }),
      );
      expect(() =>
        add({
          name: "dup",
          transport: "stdio",
          configPath: path,
          command: "echo2",
          write: capture,
        }),
      ).toThrow(/already exists/);
    });

    it("overwrites an existing entry with --force", () => {
      const path = writeConfig(
        "mcp.json",
        JSON.stringify({ mcp: { dup: { transport: "stdio", command: "echo" } } }),
      );
      add({
        name: "dup",
        transport: "stdio",
        configPath: path,
        command: "new-cmd",
        force: true,
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, { command: string }>;
      expect(mcp.dup?.command).toBe("new-cmd");
    });
  });

  describe("description (lazy entries)", () => {
    it("includes description when provided", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "chrome",
        transport: "stdio",
        configPath: path,
        command: "chromium",
        description: "Browser automation",
        write: capture,
      });
      const mcp = readJson(path).mcp as Record<string, { description: string }>;
      expect(mcp.chrome?.description).toBe("Browser automation");
    });
  });

  describe("YAML support", () => {
    it("writes to .yaml files preserving leading comments", () => {
      const path = writeConfig(
        "mcp.yaml",
        "# yaml-language-server: $schema=https://dynamicmcp.tools/config.json\n# top comment\nmcp: {}\n",
      );
      add({
        name: "x",
        transport: "stdio",
        configPath: path,
        command: "echo",
        write: capture,
      });
      const out = readFileSync(path, "utf-8");
      expect(out).toContain("# yaml-language-server");
      expect(out).toContain("# top comment");
      expect(out).toContain("x:");
      expect(out).toContain("command: echo");
    });

    it("preserves comments next to unrelated entries", () => {
      const path = writeConfig(
        "mcp.yaml",
        [
          "mcp:",
          "  # this is the filesystem MCP",
          "  filesystem:",
          "    transport: stdio",
          "    command: npx",
          "",
        ].join("\n"),
      );
      add({
        name: "github",
        transport: "streamable-http",
        configPath: path,
        url: "https://api.githubcopilot.com/mcp",
        write: capture,
      });
      const out = readFileSync(path, "utf-8");
      expect(out).toContain("# this is the filesystem MCP");
      expect(out).toContain("github:");
      expect(out).toContain("https://api.githubcopilot.com/mcp");
    });
  });

  describe("config resolution", () => {
    it("errors with a 'dynmcp init' hint when no config is found", () => {
      expect(() =>
        add({
          name: "x",
          transport: "stdio",
          configPath: join(tempDir, "missing.json"),
          command: "echo",
          write: capture,
        }),
      ).toThrow(/dynmcp init/);
    });
  });

  describe("output", () => {
    it("prints the added entry name and the path", () => {
      const path = writeConfig("mcp.json", JSON.stringify({ mcp: {} }));
      add({
        name: "x",
        transport: "stdio",
        configPath: path,
        command: "node",
        write: capture,
      });
      const out = writes.join("");
      expect(out).toContain("'x'");
      expect(out).toContain(path);
    });
  });
});
