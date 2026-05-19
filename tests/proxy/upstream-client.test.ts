import { beforeEach, describe, expect, it, vi } from "vitest";

// Variables prefixed with "mock" are automatically hoisted by Vitest and are
// available inside vi.mock() factory functions without needing vi.hoisted().
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListResources = vi.fn();
const mockListResourceTemplates = vi.fn();
const mockReadResource = vi.fn();
const mockSubscribeResource = vi.fn();
const mockUnsubscribeResource = vi.fn();
const mockListPrompts = vi.fn();
const mockGetPrompt = vi.fn();
const mockComplete = vi.fn();
const mockSetLoggingLevel = vi.fn();
const mockSendRootsListChanged = vi.fn().mockResolvedValue(undefined);
const mockGetServerCapabilities = vi.fn();
const mockSetNotificationHandler = vi.fn();
const mockSetRequestHandler = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
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
    getServerCapabilities = mockGetServerCapabilities;
    setNotificationHandler = mockSetNotificationHandler;
    setRequestHandler = mockSetRequestHandler;
  },
}));

const { UpstreamClient } = await import("../../src/proxy/upstream-client.js");

function createMockTransport() {
  return {
    onerror: undefined,
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildConnectedClient(): Promise<InstanceType<typeof UpstreamClient>> {
  const client = new UpstreamClient({ name: "test-server", transport: createMockTransport() });
  await client.connect();
  return client;
}

describe("UpstreamClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockSendRootsListChanged.mockResolvedValue(undefined);
  });

  describe("listTools()", () => {
    it("returns an array of UpstreamTool with correct name, description, and inputSchema", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_navigate",
            description: "Navigate the browser to a URL",
            inputSchema: { type: "object", properties: { url: { type: "string" } } },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: "browser_navigate",
        description: "Navigate the browser to a URL",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
      });
    });

    it("includes outputSchema when the SDK response contains it", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_screenshot",
            description: "Take a screenshot",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { data: { type: "string" } } },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools[0]?.outputSchema).toEqual({
        type: "object",
        properties: { data: { type: "string" } },
      });
    });

    it("includes annotations with all five fields when the SDK response contains them", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_click",
            description: "Click an element",
            inputSchema: { type: "object" },
            annotations: {
              title: "Browser Click",
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools[0]?.annotations).toEqual({
        title: "Browser Click",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it("omits outputSchema and annotations when they are absent from the SDK response", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_navigate",
            description: "Navigate the browser to a URL",
            inputSchema: { type: "object" },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools[0]).not.toHaveProperty("outputSchema");
      expect(tools[0]).not.toHaveProperty("annotations");
    });
  });

  describe("callTool()", () => {
    it("calls the SDK client's callTool with the correct name and arguments", async () => {
      const expectedResult = { content: [{ type: "text", text: "done" }] };
      mockCallTool.mockResolvedValue(expectedResult);

      const client = await buildConnectedClient();
      await client.callTool("browser_navigate", { url: "https://example.com" });

      expect(mockCallTool).toHaveBeenCalledWith(
        {
          name: "browser_navigate",
          arguments: { url: "https://example.com" },
        },
        undefined,
        undefined,
      );
    });

    it("returns the full result from the SDK client", async () => {
      const expectedResult = {
        content: [{ type: "text", text: "Navigation complete" }],
        isError: false,
      };
      mockCallTool.mockResolvedValue(expectedResult);

      const client = await buildConnectedClient();
      const result = await client.callTool("browser_navigate", { url: "https://example.com" });

      expect(result).toEqual(expectedResult);
    });

    it("forwards options.signal to the SDK as the third argument", async () => {
      mockCallTool.mockResolvedValue({ content: [] });
      const client = await buildConnectedClient();
      const controller = new AbortController();

      await client.callTool("x", {}, { signal: controller.signal });

      expect(mockCallTool).toHaveBeenCalledWith(expect.anything(), undefined, {
        signal: controller.signal,
      });
    });
  });

  describe("resources methods", () => {
    it("listResources returns the resources array from the SDK", async () => {
      mockListResources.mockResolvedValue({
        resources: [{ uri: "file:///a", name: "A" }],
      });
      const client = await buildConnectedClient();

      const result = await client.listResources();

      expect(result).toEqual([{ uri: "file:///a", name: "A" }]);
    });

    it("listResourceTemplates returns the resourceTemplates array from the SDK", async () => {
      mockListResourceTemplates.mockResolvedValue({
        resourceTemplates: [{ uriTemplate: "file:///{path}", name: "FS" }],
      });
      const client = await buildConnectedClient();

      const result = await client.listResourceTemplates();

      expect(result).toEqual([{ uriTemplate: "file:///{path}", name: "FS" }]);
    });

    it("readResource passes the URI to the SDK", async () => {
      mockReadResource.mockResolvedValue({ contents: [] });
      const client = await buildConnectedClient();

      await client.readResource("file:///foo");

      expect(mockReadResource).toHaveBeenCalledWith({ uri: "file:///foo" }, undefined);
    });

    it("subscribeResource passes the URI to the SDK", async () => {
      mockSubscribeResource.mockResolvedValue({});
      const client = await buildConnectedClient();

      await client.subscribeResource("file:///foo");

      expect(mockSubscribeResource).toHaveBeenCalledWith({ uri: "file:///foo" }, undefined);
    });

    it("unsubscribeResource passes the URI to the SDK", async () => {
      mockUnsubscribeResource.mockResolvedValue({});
      const client = await buildConnectedClient();

      await client.unsubscribeResource("file:///foo");

      expect(mockUnsubscribeResource).toHaveBeenCalledWith({ uri: "file:///foo" }, undefined);
    });
  });

  describe("prompts and completion methods", () => {
    it("listPrompts returns the prompts array from the SDK", async () => {
      mockListPrompts.mockResolvedValue({
        prompts: [{ name: "summarize", description: "Summarize text" }],
      });
      const client = await buildConnectedClient();

      const result = await client.listPrompts();

      expect(result).toEqual([{ name: "summarize", description: "Summarize text" }]);
    });

    it("getPrompt passes name and arguments to the SDK", async () => {
      mockGetPrompt.mockResolvedValue({ messages: [] });
      const client = await buildConnectedClient();

      await client.getPrompt("summarize", { topic: "AI" });

      expect(mockGetPrompt).toHaveBeenCalledWith(
        { name: "summarize", arguments: { topic: "AI" } },
        undefined,
      );
    });

    it("getPrompt omits arguments when not provided", async () => {
      mockGetPrompt.mockResolvedValue({ messages: [] });
      const client = await buildConnectedClient();

      await client.getPrompt("summarize");

      expect(mockGetPrompt).toHaveBeenCalledWith({ name: "summarize" }, undefined);
    });

    it("complete passes the params through to the SDK", async () => {
      mockComplete.mockResolvedValue({ completion: { values: [], hasMore: false } });
      const client = await buildConnectedClient();

      const params = {
        ref: { type: "ref/prompt" as const, name: "summarize" },
        argument: { name: "topic", value: "AI" },
      };
      await client.complete(params);

      expect(mockComplete).toHaveBeenCalledWith(params, undefined);
    });
  });

  describe("setLoggingLevel()", () => {
    it("calls the SDK with the level", async () => {
      mockSetLoggingLevel.mockResolvedValue({});
      const client = await buildConnectedClient();

      await client.setLoggingLevel("debug");

      expect(mockSetLoggingLevel).toHaveBeenCalledWith("debug", undefined);
    });
  });

  describe("sendRootsListChanged()", () => {
    it("delegates to the SDK client's sendRootsListChanged", async () => {
      const client = await buildConnectedClient();

      await client.sendRootsListChanged();

      expect(mockSendRootsListChanged).toHaveBeenCalledOnce();
    });
  });

  describe("getCapabilities()", () => {
    it("returns whatever the SDK client reports", async () => {
      mockGetServerCapabilities.mockReturnValue({ resources: { subscribe: true }, tools: {} });
      const client = await buildConnectedClient();

      expect(client.getCapabilities()).toEqual({ resources: { subscribe: true }, tools: {} });
    });

    it("returns undefined when the client is not connected", () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      expect(client.getCapabilities()).toBeUndefined();
    });
  });

  describe("connect()", () => {
    it("registers notification handlers only when they are supplied in config", async () => {
      const client = new UpstreamClient({
        name: "with-handlers",
        transport: createMockTransport(),
        notifications: {
          onToolsListChanged: () => {},
          onResourcesListChanged: () => {},
          onResourceUpdated: () => {},
          onPromptsListChanged: () => {},
          onLogMessage: () => {},
        },
      });
      await client.connect();

      // 5 notification handlers registered
      expect(mockSetNotificationHandler).toHaveBeenCalledTimes(5);
    });

    it("registers no notification handlers when none are supplied", async () => {
      const client = new UpstreamClient({
        name: "no-handlers",
        transport: createMockTransport(),
      });
      await client.connect();

      expect(mockSetNotificationHandler).not.toHaveBeenCalled();
    });

    it("registers server-side request handlers only when supplied in config", async () => {
      const client = new UpstreamClient({
        name: "with-server-reqs",
        transport: createMockTransport(),
        serverRequests: {
          onCreateMessage: async () => ({
            content: { type: "text", text: "" },
            role: "assistant",
            model: "x",
          }),
          onElicitInput: async () => ({ action: "cancel" }),
          onListRoots: async () => ({ roots: [] }),
        },
      });
      await client.connect();

      expect(mockSetRequestHandler).toHaveBeenCalledTimes(3);
    });
  });

  describe("notification handler dispatch", () => {
    it("forwards onToolsListChanged invocations to the config callback", async () => {
      const onToolsListChanged = vi.fn();
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        notifications: { onToolsListChanged },
      });
      await client.connect();

      const handler = mockSetNotificationHandler.mock.calls[0]?.[1];
      await handler?.();

      expect(onToolsListChanged).toHaveBeenCalledOnce();
    });

    it("forwards onResourcesListChanged invocations to the config callback", async () => {
      const onResourcesListChanged = vi.fn();
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        notifications: { onResourcesListChanged },
      });
      await client.connect();

      const handler = mockSetNotificationHandler.mock.calls[0]?.[1];
      await handler?.();

      expect(onResourcesListChanged).toHaveBeenCalledOnce();
    });

    it("forwards onResourceUpdated invocations with the URI param", async () => {
      const onResourceUpdated = vi.fn();
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        notifications: { onResourceUpdated },
      });
      await client.connect();

      const handler = mockSetNotificationHandler.mock.calls[0]?.[1];
      await handler?.({ params: { uri: "file:///x" } });

      expect(onResourceUpdated).toHaveBeenCalledWith({ uri: "file:///x" });
    });

    it("forwards onPromptsListChanged invocations to the config callback", async () => {
      const onPromptsListChanged = vi.fn();
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        notifications: { onPromptsListChanged },
      });
      await client.connect();

      const handler = mockSetNotificationHandler.mock.calls[0]?.[1];
      await handler?.();

      expect(onPromptsListChanged).toHaveBeenCalledOnce();
    });

    it("forwards onLogMessage invocations with the notification params", async () => {
      const onLogMessage = vi.fn();
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        notifications: { onLogMessage },
      });
      await client.connect();

      const handler = mockSetNotificationHandler.mock.calls[0]?.[1];
      await handler?.({ params: { level: "info", data: "hi" } });

      expect(onLogMessage).toHaveBeenCalledWith({ level: "info", data: "hi" });
    });
  });

  describe("server-side request handler dispatch", () => {
    it("forwards onCreateMessage invocations to the config callback with signal", async () => {
      const onCreateMessage = vi.fn().mockResolvedValue({
        content: { type: "text", text: "ok" },
        role: "assistant",
        model: "m",
      });
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        serverRequests: { onCreateMessage },
      });
      await client.connect();

      const handler = mockSetRequestHandler.mock.calls[0]?.[1];
      const params = { messages: [], maxTokens: 10 };
      const signal = new AbortController().signal;

      await handler?.({ params }, { signal });

      expect(onCreateMessage).toHaveBeenCalledWith(params, { signal });
    });

    it("forwards onElicitInput invocations to the config callback with signal", async () => {
      const onElicitInput = vi.fn().mockResolvedValue({ action: "cancel" });
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        serverRequests: { onElicitInput },
      });
      await client.connect();

      const handler = mockSetRequestHandler.mock.calls[0]?.[1];
      const params = { message: "x", requestedSchema: { type: "object", properties: {} } };
      const signal = new AbortController().signal;

      await handler?.({ params }, { signal });

      expect(onElicitInput).toHaveBeenCalledWith(params, { signal });
    });

    it("forwards onListRoots invocations to the config callback with signal", async () => {
      const onListRoots = vi.fn().mockResolvedValue({ roots: [] });
      const client = new UpstreamClient({
        name: "x",
        transport: createMockTransport(),
        serverRequests: { onListRoots },
      });
      await client.connect();

      const handler = mockSetRequestHandler.mock.calls[0]?.[1];
      const signal = new AbortController().signal;

      await handler?.({ params: undefined }, { signal });

      expect(onListRoots).toHaveBeenCalledWith(undefined, { signal });
    });
  });

  describe("disconnect()", () => {
    it("calls close on the SDK client and forgets it", async () => {
      const client = await buildConnectedClient();

      await client.disconnect();

      expect(mockClose).toHaveBeenCalledOnce();
      expect(client.getCapabilities()).toBeUndefined();
    });

    it("is a no-op when never connected", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });

      await expect(client.disconnect()).resolves.toBeUndefined();
      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe("throws when not connected", () => {
    it("listTools throws", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      await expect(client.listTools()).rejects.toThrow(/not connected/);
    });

    it("callTool throws", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      await expect(client.callTool("x", {})).rejects.toThrow(/not connected/);
    });

    it("listResources throws", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      await expect(client.listResources()).rejects.toThrow(/not connected/);
    });

    it("readResource throws", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      await expect(client.readResource("uri")).rejects.toThrow(/not connected/);
    });

    it("listPrompts throws", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      await expect(client.listPrompts()).rejects.toThrow(/not connected/);
    });

    it("sendRootsListChanged throws", async () => {
      const client = new UpstreamClient({ name: "ghost", transport: createMockTransport() });
      await expect(client.sendRootsListChanged()).rejects.toThrow(/not connected/);
    });
  });
});
