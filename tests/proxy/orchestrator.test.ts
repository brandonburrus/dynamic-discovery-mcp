import process from "node:process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamTool } from "../../src/proxy/upstream-client.js";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn<() => Promise<UpstreamTool[]>>().mockResolvedValue([]);
const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetCapabilities = vi.fn().mockReturnValue({ tools: {} });
const mockListResources = vi.fn().mockResolvedValue([]);
const mockListResourceTemplates = vi.fn().mockResolvedValue([]);
const mockReadResource = vi.fn().mockResolvedValue({ contents: [] });
const mockSubscribeResource = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribeResource = vi.fn().mockResolvedValue(undefined);
const mockListPrompts = vi.fn().mockResolvedValue([]);
const mockGetPrompt = vi.fn().mockResolvedValue({ messages: [] });
const mockComplete = vi.fn().mockResolvedValue({ completion: { values: [], hasMore: false } });
const mockSetLoggingLevel = vi.fn().mockResolvedValue(undefined);
const mockSendRootsListChanged = vi.fn().mockResolvedValue(undefined);

type CapturedConfig = {
  serverRequests: {
    onCreateMessage: (
      params: unknown,
      options: { signal: AbortSignal },
    ) => Promise<{ model: string; content: unknown; role: string }>;
    onElicitInput: (
      params: unknown,
      options: { signal: AbortSignal },
    ) => Promise<{ action: string; content?: unknown }>;
    onListRoots: (
      params: unknown,
      options: { signal: AbortSignal },
    ) => Promise<{ roots: unknown[] }>;
  };
};

let lastConfig: CapturedConfig;

vi.mock("../../src/proxy/upstream-client.js", () => {
  class MockUpstreamClient {
    constructor(config: CapturedConfig) {
      lastConfig = config;
    }
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    disconnect = mockDisconnect;
    getCapabilities = mockGetCapabilities;
    listResources = mockListResources;
    listResourceTemplates = mockListResourceTemplates;
    readResource = mockReadResource;
    subscribeResource = mockSubscribeResource;
    unsubscribeResource = mockUnsubscribeResource;
    listPrompts = mockListPrompts;
    getPrompt = mockGetPrompt;
    complete = mockComplete;
    setLoggingLevel = mockSetLoggingLevel;
    sendRootsListChanged = mockSendRootsListChanged;
  }
  return { UpstreamClient: MockUpstreamClient };
});

import { Orchestrator } from "../../src/proxy/orchestrator.js";

function createMockTransport(): Transport {
  return {} as Transport;
}

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue([]);
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mockGetCapabilities.mockReturnValue({ tools: {} });
    mockListResources.mockResolvedValue([]);
    mockListResourceTemplates.mockResolvedValue([]);
    mockListPrompts.mockResolvedValue([]);
    mockSetLoggingLevel.mockResolvedValue(undefined);
    mockSendRootsListChanged.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor validation", () => {
    it("throws when namespaced=false is given with more than one upstream", () => {
      expect(
        () =>
          new Orchestrator({
            namespaced: false,
            mcps: new Map([
              ["a", { transport: createMockTransport() }],
              ["b", { transport: createMockTransport() }],
            ]),
          }),
      ).toThrow("Single-MCP (non-namespaced) mode requires exactly one upstream");
    });

    it("throws when namespaced=false is given with zero upstreams", () => {
      expect(
        () =>
          new Orchestrator({
            namespaced: false,
            mcps: new Map(),
          }),
      ).toThrow("Single-MCP (non-namespaced) mode requires exactly one upstream");
    });

    it("allows namespaced=true with zero upstreams (empty config)", () => {
      expect(
        () =>
          new Orchestrator({
            namespaced: true,
            mcps: new Map(),
          }),
      ).not.toThrow();
    });
  });

  describe("namespaced (config-file) mode", () => {
    it("connect() creates clients and builds grouped catalog with namespaced tool names", async () => {
      const tools: UpstreamTool[] = [{ name: "read", description: "Read a file", inputSchema: {} }];
      mockListTools.mockResolvedValue(tools);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(orchestrator.catalog.tools.size).toBe(1);
      expect(orchestrator.catalog.tools.has("fs/read")).toBe(true);
    });

    it("catalog getter throws before connect", () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      expect(() => orchestrator.catalog).toThrow("Orchestrator is not connected");
    });

    it("capabilities getter throws before connect", () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      expect(() => orchestrator.capabilities).toThrow("Orchestrator is not connected");
    });

    it("callTool splits namespaced name and routes to correct client", async () => {
      mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "done" }] });

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["server", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      const result = await orchestrator.callTool("server/do-thing", { key: "value" });

      expect(mockCallTool).toHaveBeenCalledWith("do-thing", { key: "value" }, undefined);
      expect(result.content[0]).toEqual({ type: "text", text: "done" });
    });

    it("callTool throws for invalid format (no /)", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["server", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(orchestrator.callTool("no-slash", {})).rejects.toThrow(
        "Invalid namespaced tool name",
      );
    });

    it("callTool throws for unknown MCP name", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["server", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(orchestrator.callTool("unknown/tool", {})).rejects.toThrow("Unknown MCP");
    });

    it("disconnectAll disconnects all clients", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
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

  describe("non-namespaced (single-MCP) mode", () => {
    it("connect() builds a flat catalog with bare tool names", async () => {
      const tools: UpstreamTool[] = [
        { name: "browser_navigate", description: "Navigate", inputSchema: {} },
      ];
      mockListTools.mockResolvedValue(tools);

      const orchestrator = new Orchestrator({
        namespaced: false,
        mcps: new Map([["__default__", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      expect(orchestrator.catalog.tools.size).toBe(1);
      expect(orchestrator.catalog.tools.has("browser_navigate")).toBe(true);
      expect(orchestrator.catalog.tools.has("__default__/browser_navigate")).toBe(false);
    });

    it("callTool routes the bare name to the sole upstream client without splitting", async () => {
      mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "navigated" }] });

      const orchestrator = new Orchestrator({
        namespaced: false,
        mcps: new Map([["__default__", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      const result = await orchestrator.callTool("browser_navigate", {
        url: "https://example.com",
      });

      expect(mockCallTool).toHaveBeenCalledWith(
        "browser_navigate",
        { url: "https://example.com" },
        undefined,
      );
      expect(result.content[0]).toEqual({ type: "text", text: "navigated" });
    });

    it("does not interpret '/' as a namespace separator in bare-name mode", async () => {
      mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

      const orchestrator = new Orchestrator({
        namespaced: false,
        mcps: new Map([["__default__", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await orchestrator.callTool("a/b", {});

      expect(mockCallTool).toHaveBeenCalledWith("a/b", {}, undefined);
    });
  });

  describe("capabilities aggregation", () => {
    it("always advertises tools.listChanged=true and aggregates upstream capabilities", async () => {
      mockGetCapabilities.mockReturnValue({ resources: { subscribe: true }, logging: {} });

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      expect(orchestrator.capabilities.tools).toEqual({ listChanged: true });
      expect(orchestrator.capabilities.resources?.subscribe).toBe(true);
      expect(orchestrator.capabilities.logging).toBeDefined();
    });
  });

  describe("resources routing", () => {
    it("lists aggregated resources across upstreams", async () => {
      mockGetCapabilities.mockReturnValue({ resources: {} });
      mockListResources.mockResolvedValue([{ uri: "file:///a", name: "A" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      const resources = orchestrator.listResources();
      expect(resources).toEqual([{ uri: "file:///a", name: "A" }]);
    });

    it("lists aggregated templates across upstreams", async () => {
      mockGetCapabilities.mockReturnValue({ resources: {} });
      mockListResourceTemplates.mockResolvedValue([{ uriTemplate: "file:///{path}", name: "FS" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      expect(orchestrator.listResourceTemplates()).toEqual([
        { uriTemplate: "file:///{path}", name: "FS" },
      ]);
    });

    it("readResource routes to the URI owner", async () => {
      mockGetCapabilities.mockReturnValue({ resources: {} });
      mockListResources.mockResolvedValue([{ uri: "file:///a", name: "A" }]);
      mockReadResource.mockResolvedValue({ contents: [{ uri: "file:///a", text: "hi" }] });

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      const result = await orchestrator.readResource("file:///a");
      expect(mockReadResource).toHaveBeenCalledWith("file:///a", undefined);
      expect(result.contents[0]).toEqual({ uri: "file:///a", text: "hi" });
    });

    it("readResource throws on unknown URI", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(orchestrator.readResource("file:///unknown")).rejects.toThrow(
        /Unknown resource/,
      );
    });

    it("subscribeResource and unsubscribeResource route to the URI owner", async () => {
      mockGetCapabilities.mockReturnValue({ resources: { subscribe: true } });
      mockListResources.mockResolvedValue([{ uri: "file:///a", name: "A" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await orchestrator.subscribeResource("file:///a");
      await orchestrator.unsubscribeResource("file:///a");

      expect(mockSubscribeResource).toHaveBeenCalledWith("file:///a", undefined);
      expect(mockUnsubscribeResource).toHaveBeenCalledWith("file:///a", undefined);
    });

    it("listResources throws before connect", () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["fs", { transport: createMockTransport() }]]),
      });
      expect(() => orchestrator.listResources()).toThrow(/not connected/);
    });
  });

  describe("prompts routing", () => {
    it("lists aggregated prompts", async () => {
      mockGetCapabilities.mockReturnValue({ prompts: {} });
      mockListPrompts.mockResolvedValue([{ name: "summarize", description: "S" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["p", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      expect(orchestrator.listPrompts()).toEqual([{ name: "summarize", description: "S" }]);
    });

    it("getPrompt routes by name", async () => {
      mockGetCapabilities.mockReturnValue({ prompts: {} });
      mockListPrompts.mockResolvedValue([{ name: "summarize", description: "S" }]);
      mockGetPrompt.mockResolvedValue({
        messages: [{ role: "user", content: { type: "text", text: "x" } }],
      });

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["p", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      const result = await orchestrator.getPrompt("summarize", { topic: "AI" });
      expect(mockGetPrompt).toHaveBeenCalledWith("summarize", { topic: "AI" }, undefined);
      expect(result.messages).toHaveLength(1);
    });

    it("getPrompt throws on unknown prompt", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["p", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(orchestrator.getPrompt("ghost")).rejects.toThrow(/Unknown prompt/);
    });
  });

  describe("completion routing", () => {
    it("routes ref/prompt completions to the prompt owner", async () => {
      mockGetCapabilities.mockReturnValue({ prompts: {}, completions: {} });
      mockListPrompts.mockResolvedValue([{ name: "summarize", description: "S" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["p", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await orchestrator.complete({
        ref: { type: "ref/prompt", name: "summarize" },
        argument: { name: "topic", value: "A" },
      });

      expect(mockComplete).toHaveBeenCalledOnce();
    });

    it("routes ref/resource completions to the resource URI owner", async () => {
      mockGetCapabilities.mockReturnValue({ resources: {}, completions: {} });
      mockListResources.mockResolvedValue([{ uri: "file:///a", name: "A" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["r", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await orchestrator.complete({
        ref: { type: "ref/resource", uri: "file:///a" },
        argument: { name: "x", value: "y" },
      });

      expect(mockComplete).toHaveBeenCalledOnce();
    });

    it("throws on an unsupported ref type", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["p", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      const badParams = {
        ref: { type: "ref/unknown", name: "x" },
        argument: { name: "a", value: "b" },
      } as unknown as Parameters<typeof orchestrator.complete>[0];

      await expect(orchestrator.complete(badParams)).rejects.toThrow(
        /Unsupported completion ref type/,
      );
    });
  });

  describe("setLoggingLevel broadcast", () => {
    it("calls setLoggingLevel on an upstream advertising the logging capability", async () => {
      mockGetCapabilities.mockReturnValue({ logging: {} });

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await orchestrator.setLoggingLevel("info");

      expect(mockSetLoggingLevel).toHaveBeenCalledTimes(1);
      expect(mockSetLoggingLevel).toHaveBeenCalledWith("info", undefined);
    });

    it("skips upstreams that do not advertise the logging capability", async () => {
      mockGetCapabilities.mockReturnValue({ tools: {} });

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await orchestrator.setLoggingLevel("info");

      expect(mockSetLoggingLevel).not.toHaveBeenCalled();
    });

    it("swallows individual upstream failures", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mockGetCapabilities.mockReturnValue({ logging: {} });
      mockSetLoggingLevel.mockRejectedValueOnce(new Error("boom"));

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(orchestrator.setLoggingLevel("info")).resolves.toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("setLoggingLevel failed"));
    });
  });

  describe("broadcastRootsListChanged", () => {
    it("calls sendRootsListChanged on every connected upstream", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([
          ["a", { transport: createMockTransport() }],
          ["b", { transport: createMockTransport() }],
        ]),
      });
      await orchestrator.connect();

      await orchestrator.broadcastRootsListChanged();

      expect(mockSendRootsListChanged).toHaveBeenCalledTimes(2);
    });

    it("swallows individual upstream failures", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mockSendRootsListChanged.mockRejectedValueOnce(new Error("boom"));

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(orchestrator.broadcastRootsListChanged()).resolves.toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("sendRootsListChanged failed"),
      );
    });
  });

  describe("server-initiated request forwarders", () => {
    it("onCreateMessage handler invokes the registered forwarder", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      const onCreateMessage = vi.fn().mockResolvedValue({
        content: { type: "text", text: "" },
        role: "assistant",
        model: "m",
      });
      orchestrator.setServerRequestForwarders({ onCreateMessage });
      await orchestrator.connect();

      const params = { messages: [], maxTokens: 100 };
      const signal = new AbortController().signal;
      const result = await lastConfig.serverRequests.onCreateMessage(params, { signal });

      expect(onCreateMessage).toHaveBeenCalledWith(params, { signal });
      expect(result.model).toBe("m");
    });

    it("onCreateMessage throws when no forwarder is registered", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(
        lastConfig.serverRequests.onCreateMessage(
          { messages: [], maxTokens: 100 },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/Proxy does not support sampling/);
    });

    it("onElicitInput handler invokes the registered forwarder", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      const onElicitInput = vi.fn().mockResolvedValue({ action: "accept", content: {} });
      orchestrator.setServerRequestForwarders({ onElicitInput });
      await orchestrator.connect();

      const params = { message: "x", requestedSchema: { type: "object" as const, properties: {} } };
      const signal = new AbortController().signal;
      const result = await lastConfig.serverRequests.onElicitInput(params, { signal });

      expect(onElicitInput).toHaveBeenCalledWith(params, { signal });
      expect(result.action).toBe("accept");
    });

    it("onElicitInput throws when no forwarder is registered", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(
        lastConfig.serverRequests.onElicitInput(
          { message: "x", requestedSchema: { type: "object", properties: {} } },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/Proxy does not support elicitation/);
    });

    it("onListRoots handler invokes the registered forwarder", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      const onListRoots = vi.fn().mockResolvedValue({ roots: [] });
      orchestrator.setServerRequestForwarders({ onListRoots });
      await orchestrator.connect();

      const signal = new AbortController().signal;
      const result = await lastConfig.serverRequests.onListRoots(undefined, { signal });

      expect(onListRoots).toHaveBeenCalledWith(undefined, { signal });
      expect(result.roots).toEqual([]);
    });

    it("onListRoots throws when no forwarder is registered", async () => {
      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([["a", { transport: createMockTransport() }]]),
      });
      await orchestrator.connect();

      await expect(
        lastConfig.serverRequests.onListRoots(undefined, {
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/Proxy does not support roots/);
    });
  });

  describe("collision logging", () => {
    it("writes a stderr warning when two upstreams advertise the same resource URI", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mockGetCapabilities.mockReturnValue({ resources: {} });
      mockListResources
        .mockResolvedValueOnce([{ uri: "file:///a", name: "A" }])
        .mockResolvedValueOnce([{ uri: "file:///a", name: "Dup" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([
          ["first", { transport: createMockTransport() }],
          ["second", { transport: createMockTransport() }],
        ]),
      });
      await orchestrator.connect();

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("resource URI collision"));
    });

    it("writes a stderr warning when two upstreams advertise the same prompt name", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mockGetCapabilities.mockReturnValue({ prompts: {} });
      mockListPrompts
        .mockResolvedValueOnce([{ name: "summarize", description: "S1" }])
        .mockResolvedValueOnce([{ name: "summarize", description: "S2" }]);

      const orchestrator = new Orchestrator({
        namespaced: true,
        mcps: new Map([
          ["first", { transport: createMockTransport() }],
          ["second", { transport: createMockTransport() }],
        ]),
      });
      await orchestrator.connect();

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("prompt name collision"));
    });
  });
});
