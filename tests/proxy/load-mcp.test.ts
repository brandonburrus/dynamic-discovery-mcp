import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamTool } from "../../src/proxy/upstream-client.js";

// Same mocking pattern as orchestrator.test.ts — the UpstreamClient is faked at
// the module level so we can drive eager-vs-lazy behavior without spawning real
// upstream processes or HTTP servers. This file exercises the full chain:
// real Orchestrator + real ProxyServer (via InMemoryTransport) + a real host-side
// SDK Client invoking the `load_mcp` meta-tool over the wire.

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn<() => Promise<UpstreamTool[]>>().mockResolvedValue([]);
const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetCapabilities = vi.fn().mockReturnValue({ tools: {} });
const mockListResources = vi.fn().mockResolvedValue([]);
const mockListResourceTemplates = vi.fn().mockResolvedValue([]);
const mockListPrompts = vi.fn().mockResolvedValue([]);
const mockSendRootsListChanged = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/proxy/upstream-client.js", () => {
  class MockUpstreamClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    disconnect = mockDisconnect;
    getCapabilities = mockGetCapabilities;
    listResources = mockListResources;
    listResourceTemplates = mockListResourceTemplates;
    listPrompts = mockListPrompts;
    sendRootsListChanged = mockSendRootsListChanged;
  }
  return { UpstreamClient: MockUpstreamClient };
});

import { Orchestrator } from "../../src/proxy/orchestrator.js";
import { ProxyServer } from "../../src/proxy/server.js";

function makeTransport(): Transport {
  return {} as Transport;
}

type Pair = {
  client: Client;
  close: () => Promise<void>;
};

async function startProxiedPair(orchestrator: Orchestrator): Promise<Pair> {
  const proxy = new ProxyServer({
    catalog: () => orchestrator.catalog,
    capabilities: orchestrator.capabilities,
    callTool: (name, input, options) => orchestrator.callTool(name, input, options),
    loadMcp: orchestrator.hasDynamicDiscovery
      ? mcpName => orchestrator.loadMcp(mcpName)
      : undefined,
  });

  orchestrator.setNotificationHandlers({
    onToolsListChanged: () => proxy.sendToolListChanged(),
  });

  const server = proxy.buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      await orchestrator.disconnectAll();
    },
  };
}

describe("end-to-end load_mcp via InMemoryTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue([]);
    mockGetCapabilities.mockReturnValue({ tools: {} });
    mockListResources.mockResolvedValue([]);
    mockListResourceTemplates.mockResolvedValue([]);
    mockListPrompts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers load_mcp on the host when the config declares a lazy MCP", async () => {
    const orchestrator = new Orchestrator({
      namespaced: true,
      eagerMcps: new Map([["eager", { transport: makeTransport() }]]),
      lazyMcps: new Map([["chrome", { transport: makeTransport(), description: "Browser" }]]),
    });
    await orchestrator.connect();

    const pair = await startProxiedPair(orchestrator);
    try {
      const result = await pair.client.listTools();
      const names = result.tools.map(tool => tool.name).sort();
      expect(names).toContain("load_mcp");
    } finally {
      await pair.close();
    }
  });

  it("does NOT register load_mcp when the config has no lazy MCPs", async () => {
    const orchestrator = new Orchestrator({
      namespaced: true,
      eagerMcps: new Map([["eager", { transport: makeTransport() }]]),
    });
    await orchestrator.connect();

    const pair = await startProxiedPair(orchestrator);
    try {
      const result = await pair.client.listTools();
      const names = result.tools.map(tool => tool.name);
      expect(names).not.toContain("load_mcp");
    } finally {
      await pair.close();
    }
  });

  it("load_mcp returns the loaded MCP's tools and triggers tools/list_changed", async () => {
    // Sequenced mocks: eager listTools first (returns []), then lazy listTools
    // (returns one tool).
    mockListTools
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { name: "browser_navigate", description: "Navigate", inputSchema: {} },
      ]);
    mockGetCapabilities.mockReturnValue({ tools: {} });

    const orchestrator = new Orchestrator({
      namespaced: true,
      eagerMcps: new Map([["eager", { transport: makeTransport() }]]),
      lazyMcps: new Map([["chrome", { transport: makeTransport(), description: "Browser" }]]),
    });
    await orchestrator.connect();

    const pair = await startProxiedPair(orchestrator);
    try {
      // Subscribe to tools/list_changed before the load so we can confirm the
      // notification actually traverses the SDK boundary into the host client.
      const listChangedFired = new Promise<void>(resolve => {
        pair.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          resolve();
          return Promise.resolve();
        });
      });

      const loadResult = await pair.client.callTool({
        name: "load_mcp",
        arguments: { mcp_name: "chrome" },
      });

      const text = (loadResult.content as Array<{ type: string; text: string }>)[0]?.text;
      const parsed = JSON.parse(text);
      expect(parsed).toMatchObject({
        mcp_name: "chrome",
        tools: [{ name: "chrome/browser_navigate", description: "Navigate" }],
      });

      // Wait for the host-bound notification to land.
      await listChangedFired;

      // discover_tool description now lists chrome's tool, not the lazy stub.
      const listTools = await pair.client.listTools();
      const discover = listTools.tools.find(tool => tool.name === "discover_tool");
      expect(discover?.description).toContain("chrome:");
      expect(discover?.description).toContain("- browser_navigate:");
      expect(discover?.description).not.toMatch(/chrome:\s+Browser/);
    } finally {
      await pair.close();
    }
  });

  it("load_mcp on an unknown name returns isError with the lazy alternatives in the message", async () => {
    const orchestrator = new Orchestrator({
      namespaced: true,
      eagerMcps: new Map([["eager", { transport: makeTransport() }]]),
      lazyMcps: new Map([["chrome", { transport: makeTransport(), description: "Browser" }]]),
    });
    await orchestrator.connect();

    const pair = await startProxiedPair(orchestrator);
    try {
      const result = await pair.client.callTool({
        name: "load_mcp",
        arguments: { mcp_name: "ghost" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toContain("ghost");
      expect(text).toContain("chrome");
    } finally {
      await pair.close();
    }
  });

  it("third consecutive load failure evicts the lazy entry from <mcp_servers>", async () => {
    mockListTools.mockReset();
    mockListTools
      .mockResolvedValueOnce([]) // eager listTools at connect
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockRejectedValueOnce(new Error("boom 2"))
      .mockRejectedValueOnce(new Error("boom 3"));
    mockGetCapabilities.mockReturnValue({ tools: {} });

    const orchestrator = new Orchestrator({
      namespaced: true,
      eagerMcps: new Map([["eager", { transport: makeTransport() }]]),
      lazyMcps: new Map([["chrome", { transport: makeTransport(), description: "Browser" }]]),
    });
    await orchestrator.connect();

    const pair = await startProxiedPair(orchestrator);
    try {
      await pair.client.callTool({ name: "load_mcp", arguments: { mcp_name: "chrome" } });
      await pair.client.callTool({ name: "load_mcp", arguments: { mcp_name: "chrome" } });
      const third = await pair.client.callTool({
        name: "load_mcp",
        arguments: { mcp_name: "chrome" },
      });

      expect(third.isError).toBe(true);
      const text = (third.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toMatch(/no longer be offered/i);

      // <mcp_servers> no longer includes chrome.
      const listTools = await pair.client.listTools();
      const discover = listTools.tools.find(tool => tool.name === "discover_tool");
      expect(discover?.description).not.toMatch(/chrome:\s+Browser/);
    } finally {
      await pair.close();
    }
  });
});
