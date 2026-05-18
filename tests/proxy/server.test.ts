import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCatalog } from "../../src/proxy/tool-catalog.js";
import type { UpstreamTool } from "../../src/proxy/upstream-client.js";

// Variables prefixed with "mock" are automatically hoisted by Vitest and are
// available inside vi.mock() factory functions without needing vi.hoisted().
const mockAddTool = vi.fn();
const mockFastMcpStart = vi.fn().mockResolvedValue(undefined);

vi.mock("fastmcp", () => ({
  FastMCP: class {
    addTool = mockAddTool;
    start = mockFastMcpStart;
  },
}));

const { ProxyServer } = await import("../../src/proxy/server.js");

type AddToolConfig = {
  name: string;
  execute: (args: Record<string, unknown>) => unknown;
};

/** Extracts the execute callback registered for a named tool from addTool spy calls. */
function captureExecute(toolName: string): (args: Record<string, unknown>) => unknown {
  const call = (mockAddTool.mock.calls as AddToolConfig[][]).find(
    ([config]) => config.name === toolName,
  );
  if (call === undefined) {
    throw new Error(`addTool was never called with name "${toolName}"`);
  }
  return call[0].execute;
}

const knownTool: UpstreamTool = {
  name: "known_tool",
  description: "A known tool",
  inputSchema: { type: "object" },
};

describe("ProxyServer", () => {
  const fakeCatalog = {
    discoverToolDescription: "Discover a tool by name",
    getToolDetails: vi.fn(),
    tools: new Map<string, UpstreamTool>([["known_tool", knownTool]]),
  } as unknown as ToolCatalog;

  const fakeCallTool = vi.fn();

  let mockStderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFastMcpStart.mockResolvedValue(undefined);
    mockStderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  function buildServer(): InstanceType<typeof ProxyServer> {
    return new ProxyServer({ catalog: fakeCatalog, callTool: fakeCallTool });
  }

  describe("start()", () => {
    it("calls server.start with stdio transport", async () => {
      await buildServer().start();

      expect(mockFastMcpStart).toHaveBeenCalledWith({ transportType: "stdio" });
    });

    it("writes the startup message to process.stderr", async () => {
      await buildServer().start();

      expect(mockStderrWrite).toHaveBeenCalledWith(
        "Starting dynamic-discovery-mcp server over stdio\n",
      );
    });

    it("registers both discover_tool and use_tool via addTool", async () => {
      await buildServer().start();

      const registeredNames = (mockAddTool.mock.calls as AddToolConfig[][]).map(
        ([config]) => config.name,
      );
      expect(registeredNames).toContain("discover_tool");
      expect(registeredNames).toContain("use_tool");
    });
  });

  describe("discover_tool execute", () => {
    it("calls catalog.getToolDetails with the provided tool_name and returns the result", async () => {
      (fakeCatalog.getToolDetails as ReturnType<typeof vi.fn>).mockReturnValue(
        "tool details string",
      );

      await buildServer().start();
      const execute = captureExecute("discover_tool");

      const result = await execute({ tool_name: "known_tool" });

      expect(fakeCatalog.getToolDetails).toHaveBeenCalledWith("known_tool");
      expect(result).toBe("tool details string");
    });
  });

  describe("use_tool execute", () => {
    it("calls upstreamClient.callTool for a known tool and returns the result", async () => {
      const callToolResult = { content: [{ type: "text", text: "ok" }] };
      fakeCallTool.mockResolvedValue(callToolResult);

      await buildServer().start();
      const execute = captureExecute("use_tool");

      const result = await execute({
        tool_name: "known_tool",
        tool_input: { url: "https://example.com" },
      });

      expect(fakeCallTool).toHaveBeenCalledWith("known_tool", {
        url: "https://example.com",
      });
      expect(result).toBe(callToolResult);
    });

    it("falls back to catalog.getToolDetails for an unknown tool and does NOT call upstreamClient.callTool", async () => {
      (fakeCatalog.getToolDetails as ReturnType<typeof vi.fn>).mockReturnValue(
        "Unknown tool: unknown_tool",
      );

      await buildServer().start();
      const execute = captureExecute("use_tool");

      const result = await execute({ tool_name: "unknown_tool", tool_input: {} });

      expect(fakeCallTool).not.toHaveBeenCalled();
      expect(fakeCatalog.getToolDetails).toHaveBeenCalledWith("unknown_tool");
      expect(result).toBe("Unknown tool: unknown_tool");
    });
  });
});
