import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamTool } from "../../src/proxy/upstream-client.js";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn<() => Promise<UpstreamTool[]>>().mockResolvedValue([]);
const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/proxy/upstream-client.js", () => {
  class MockUpstreamClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    disconnect = mockDisconnect;
  }
  return { UpstreamClient: MockUpstreamClient };
});

import { Orchestrator } from "../../src/proxy/orchestrator.js";

function createMockTransport(): import("@modelcontextprotocol/sdk/shared/transport.js").Transport {
  return {} as import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
}

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue([]);
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connect() creates clients and builds grouped catalog", async () => {
    const tools: UpstreamTool[] = [{ name: "read", description: "Read a file", inputSchema: {} }];
    mockListTools.mockResolvedValue(tools);

    const orchestrator = new Orchestrator({
      mcps: new Map([["fs", { transport: createMockTransport() }]]),
    });
    await orchestrator.connect();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(orchestrator.catalog).toBeDefined();
    expect(orchestrator.catalog.tools.size).toBe(1);
    expect(orchestrator.catalog.tools.has("fs/read")).toBe(true);
  });

  it("catalog getter throws before connect", () => {
    const orchestrator = new Orchestrator({ mcps: new Map() });
    expect(() => orchestrator.catalog).toThrow("Orchestrator is not connected");
  });

  it("callTool splits namespaced name and routes to correct client", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "done" }] });

    const orchestrator = new Orchestrator({
      mcps: new Map([["server", { transport: createMockTransport() }]]),
    });
    await orchestrator.connect();

    const result = await orchestrator.callTool("server/do-thing", { key: "value" });

    expect(mockCallTool).toHaveBeenCalledWith("do-thing", { key: "value" });
    expect(result.content[0]).toEqual({ type: "text", text: "done" });
  });

  it("callTool throws for invalid format (no /)", async () => {
    const orchestrator = new Orchestrator({
      mcps: new Map([["server", { transport: createMockTransport() }]]),
    });
    await orchestrator.connect();

    await expect(orchestrator.callTool("no-slash", {})).rejects.toThrow(
      "Invalid namespaced tool name",
    );
  });

  it("callTool throws for unknown MCP name", async () => {
    const orchestrator = new Orchestrator({
      mcps: new Map([["server", { transport: createMockTransport() }]]),
    });
    await orchestrator.connect();

    await expect(orchestrator.callTool("unknown/tool", {})).rejects.toThrow("Unknown MCP");
  });

  it("disconnectAll disconnects all clients", async () => {
    const orchestrator = new Orchestrator({
      mcps: new Map([
        ["a", { transport: createMockTransport() }],
        ["b", { transport: createMockTransport() }],
      ]),
    });
    await orchestrator.connect();
    await orchestrator.disconnectAll();

    expect(mockDisconnect).toHaveBeenCalledTimes(2);
    expect(() => orchestrator.catalog).toThrow("Orchestrator is not connected");
  });
});
