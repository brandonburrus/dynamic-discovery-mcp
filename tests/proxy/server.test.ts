import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type ServerCapabilities,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCatalog } from "../../src/proxy/tool-catalog.js";
import {
  type CompletionCallback,
  type LoadMcpCallback,
  type LoggingSetLevelCallback,
  type PromptCallbacks,
  ProxyServer,
  type ResourceCallbacks,
  type ToolCaller,
} from "../../src/proxy/server.js";
import type { UpstreamTool } from "../../src/proxy/upstream-client.js";

const knownTool: UpstreamTool = {
  name: "known_tool",
  description: "A known tool",
  inputSchema: { type: "object" },
};

type FakeCatalogOverrides = {
  discoverToolDescription?: string;
  getToolDetails?: (name: string) => string;
  tools?: Map<string, UpstreamTool>;
};

function makeCatalog(overrides: FakeCatalogOverrides = {}): {
  catalog: ToolCatalog;
  getToolDetails: ReturnType<typeof vi.fn>;
} {
  const getToolDetails = vi.fn(overrides.getToolDetails ?? (() => "details"));
  const catalog = {
    discoverToolDescription: overrides.discoverToolDescription ?? "Discover a tool by name",
    getToolDetails,
    tools: overrides.tools ?? new Map<string, UpstreamTool>([["known_tool", knownTool]]),
  } as unknown as ToolCatalog;
  return { catalog, getToolDetails };
}

type Pair = {
  client: Client;
  proxy: ProxyServer;
  close: () => Promise<void>;
};

type StartOpts = {
  catalog: ToolCatalog;
  callTool?: ToolCaller;
  capabilities?: ServerCapabilities;
  resources?: ResourceCallbacks;
  prompts?: PromptCallbacks;
  complete?: CompletionCallback;
  setLoggingLevel?: LoggingSetLevelCallback;
  onRootsListChanged?: () => void | Promise<void>;
  loadMcp?: LoadMcpCallback;
};

async function startPair(opts: StartOpts): Promise<Pair> {
  const callTool: ToolCaller =
    opts.callTool ?? (async () => ({ content: [{ type: "text", text: "noop" }] }));
  const proxy = new ProxyServer({
    catalog: () => opts.catalog,
    capabilities: opts.capabilities ?? { tools: { listChanged: true } },
    callTool,
    resources: opts.resources,
    prompts: opts.prompts,
    complete: opts.complete,
    setLoggingLevel: opts.setLoggingLevel,
    onRootsListChanged: opts.onRootsListChanged,
    loadMcp: opts.loadMcp,
  });
  const server = proxy.buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    proxy,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("ProxyServer", () => {
  let openPairs: Pair[] = [];

  beforeEach(() => {
    openPairs = [];
  });

  afterEach(async () => {
    await Promise.all(openPairs.map(pair => pair.close()));
    openPairs = [];
  });

  async function start(opts: StartOpts): Promise<Pair> {
    const pair = await startPair(opts);
    openPairs.push(pair);
    return pair;
  }

  describe("tools/list", () => {
    it("advertises exactly discover_tool and use_tool", async () => {
      const { catalog } = makeCatalog();
      const { client } = await start({ catalog });

      const result = await client.listTools();
      const names = result.tools.map(tool => tool.name).sort();

      expect(names).toEqual(["discover_tool", "use_tool"]);
    });

    it("uses the catalog's discoverToolDescription as the discover_tool description", async () => {
      const { catalog } = makeCatalog({
        discoverToolDescription: "<tools>\n- known_tool: A known tool\n</tools>",
      });
      const { client } = await start({ catalog });

      const result = await client.listTools();
      const discover = result.tools.find(tool => tool.name === "discover_tool");

      expect(discover?.description).toBe("<tools>\n- known_tool: A known tool\n</tools>");
    });

    it("uses a static description for use_tool", async () => {
      const { catalog } = makeCatalog();
      const { client } = await start({ catalog });

      const result = await client.listTools();
      const useTool = result.tools.find(tool => tool.name === "use_tool");

      expect(useTool?.description).toBe(
        "Use a tool that was previously discovered with the discover_tool tool.",
      );
    });

    it("does NOT advertise load_mcp when no loadMcp callback is provided", async () => {
      const { catalog } = makeCatalog();
      const { client } = await start({ catalog });

      const result = await client.listTools();
      const names = result.tools.map(tool => tool.name);

      expect(names).not.toContain("load_mcp");
    });

    it("advertises load_mcp when the loadMcp callback is provided", async () => {
      const { catalog } = makeCatalog();
      const loadMcp = vi.fn().mockResolvedValue({
        mcp_name: "chrome",
        tools: [],
        resources: [],
        resource_templates: [],
        prompts: [],
      });
      const { client } = await start({ catalog, loadMcp });

      const result = await client.listTools();
      const loadMcpTool = result.tools.find(tool => tool.name === "load_mcp");

      expect(loadMcpTool).toBeDefined();
      expect(loadMcpTool?.description).toContain("Load a previously-deferred MCP server");
      expect(loadMcpTool?.inputSchema).toMatchObject({
        type: "object",
        properties: { mcp_name: { type: "string" } },
        required: ["mcp_name"],
      });
    });
  });

  describe("load_mcp", () => {
    it("invokes the loadMcp callback with the mcp_name argument", async () => {
      const { catalog } = makeCatalog();
      const loadMcp = vi.fn().mockResolvedValue({
        mcp_name: "chrome",
        tools: [{ name: "chrome/foo", description: "F" }],
        resources: [],
        resource_templates: [],
        prompts: [],
      });
      const { client } = await start({ catalog, loadMcp });

      const result = await client.callTool({
        name: "load_mcp",
        arguments: { mcp_name: "chrome" },
      });

      expect(loadMcp).toHaveBeenCalledWith("chrome");
      // The structured result is JSON-stringified into text content.
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      const parsed = JSON.parse(text);
      expect(parsed).toMatchObject({
        mcp_name: "chrome",
        tools: [{ name: "chrome/foo", description: "F" }],
      });
    });

    it("returns isError=true when the loadMcp callback throws", async () => {
      const { catalog } = makeCatalog();
      const loadMcp = vi.fn().mockRejectedValue(new Error("upstream down"));
      const { client } = await start({ catalog, loadMcp });

      const result = await client.callTool({
        name: "load_mcp",
        arguments: { mcp_name: "broken" },
      });

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0]?.text).toContain(
        "upstream down",
      );
    });
  });

  describe("discover_tool", () => {
    it("calls catalog.getToolDetails with the provided tool_name and returns the text", async () => {
      const { catalog, getToolDetails } = makeCatalog({
        getToolDetails: () => "tool details string",
      });
      const { client } = await start({ catalog });

      const result = await client.callTool({
        name: "discover_tool",
        arguments: { tool_name: "known_tool" },
      });

      expect(getToolDetails).toHaveBeenCalledWith("known_tool");
      expect(result.content).toEqual([{ type: "text", text: "tool details string" }]);
    });
  });

  describe("use_tool", () => {
    it("invokes callTool for a known tool and returns its result verbatim", async () => {
      const expectedResult = { content: [{ type: "text" as const, text: "ok" }] };
      const callTool = vi.fn<ToolCaller>().mockResolvedValue(expectedResult);
      const { catalog } = makeCatalog();
      const { client } = await start({ catalog, callTool });

      const result = await client.callTool({
        name: "use_tool",
        arguments: { tool_name: "known_tool", tool_input: { url: "https://example.com" } },
      });

      expect(callTool).toHaveBeenCalledWith(
        "known_tool",
        { url: "https://example.com" },
        expect.anything(),
      );
      expect(result.content).toEqual(expectedResult.content);
    });

    it("falls back to discover_tool details when the tool is unknown and does NOT call callTool", async () => {
      const callTool = vi.fn<ToolCaller>();
      const { catalog, getToolDetails } = makeCatalog({
        getToolDetails: () => "Unknown tool: foo. Available tools: known_tool",
      });
      const { client } = await start({ catalog, callTool });

      const result = await client.callTool({
        name: "use_tool",
        arguments: { tool_name: "foo", tool_input: {} },
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(getToolDetails).toHaveBeenCalledWith("foo");
      expect(result.content).toEqual([
        { type: "text", text: "Unknown tool: foo. Available tools: known_tool" },
      ]);
    });

    it("defaults tool_input to an empty object when not provided", async () => {
      const callTool = vi
        .fn<ToolCaller>()
        .mockResolvedValue({ content: [{ type: "text", text: "" }] });
      const { catalog } = makeCatalog();
      const { client } = await start({ catalog, callTool });

      await client.callTool({
        name: "use_tool",
        arguments: { tool_name: "known_tool" },
      });

      expect(callTool).toHaveBeenCalledWith("known_tool", {}, expect.anything());
    });
  });

  describe("resources", () => {
    const resourceA = { uri: "file:///a", name: "A" };
    const resourceB = { uri: "file:///b", name: "B" };
    const templateA = { uriTemplate: "file:///{path}", name: "FS" };

    function buildResourceCallbacks(): {
      callbacks: ResourceCallbacks;
      spies: {
        listResources: ReturnType<typeof vi.fn>;
        listResourceTemplates: ReturnType<typeof vi.fn>;
        readResource: ReturnType<typeof vi.fn>;
        subscribeResource: ReturnType<typeof vi.fn>;
        unsubscribeResource: ReturnType<typeof vi.fn>;
      };
    } {
      const listResources = vi.fn(() => [resourceA, resourceB]);
      const listResourceTemplates = vi.fn(() => [templateA]);
      const readResource = vi.fn(async (uri: string) => ({
        contents: [{ uri, text: `contents of ${uri}`, mimeType: "text/plain" }],
      }));
      const subscribeResource = vi.fn(async () => {});
      const unsubscribeResource = vi.fn(async () => {});
      return {
        callbacks: {
          listResources,
          listResourceTemplates,
          readResource,
          subscribeResource,
          unsubscribeResource,
        },
        spies: {
          listResources,
          listResourceTemplates,
          readResource,
          subscribeResource,
          unsubscribeResource,
        },
      };
    }

    const RESOURCE_CAPS: ServerCapabilities = {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
    };

    it("resources/list returns what the callback provides", async () => {
      const { catalog } = makeCatalog();
      const { callbacks, spies } = buildResourceCallbacks();
      const { client } = await start({
        catalog,
        capabilities: RESOURCE_CAPS,
        resources: callbacks,
      });

      const result = await client.listResources();

      expect(spies.listResources).toHaveBeenCalled();
      expect(result.resources.map(r => r.uri)).toEqual(["file:///a", "file:///b"]);
    });

    it("resources/templates/list returns what the callback provides", async () => {
      const { catalog } = makeCatalog();
      const { callbacks, spies } = buildResourceCallbacks();
      const { client } = await start({
        catalog,
        capabilities: RESOURCE_CAPS,
        resources: callbacks,
      });

      const result = await client.listResourceTemplates();

      expect(spies.listResourceTemplates).toHaveBeenCalled();
      expect(result.resourceTemplates.map(t => t.uriTemplate)).toEqual(["file:///{path}"]);
    });

    it("resources/read routes by URI to the callback", async () => {
      const { catalog } = makeCatalog();
      const { callbacks, spies } = buildResourceCallbacks();
      const { client } = await start({
        catalog,
        capabilities: RESOURCE_CAPS,
        resources: callbacks,
      });

      const result = await client.readResource({ uri: "file:///a" });

      expect(spies.readResource).toHaveBeenCalledWith("file:///a", expect.anything());
      const first = result.contents[0];
      expect(first !== undefined && "text" in first ? first.text : undefined).toBe(
        "contents of file:///a",
      );
    });

    it("resources/subscribe and resources/unsubscribe route by URI to the callback", async () => {
      const { catalog } = makeCatalog();
      const { callbacks, spies } = buildResourceCallbacks();
      const { client } = await start({
        catalog,
        capabilities: RESOURCE_CAPS,
        resources: callbacks,
      });

      await client.subscribeResource({ uri: "file:///a" });
      await client.unsubscribeResource({ uri: "file:///a" });

      expect(spies.subscribeResource).toHaveBeenCalledWith("file:///a", expect.anything());
      expect(spies.unsubscribeResource).toHaveBeenCalledWith("file:///a", expect.anything());
    });

    it("does not register resource handlers when capabilities.resources is undefined", async () => {
      const { catalog } = makeCatalog();
      const { callbacks } = buildResourceCallbacks();
      const { client } = await start({
        catalog,
        capabilities: { tools: { listChanged: true } },
        resources: callbacks,
      });

      await expect(client.listResources()).rejects.toThrow();
    });

    it("sendResourceListChanged emits notifications/resources/list_changed to host", async () => {
      const { catalog } = makeCatalog();
      const { callbacks } = buildResourceCallbacks();
      const { client, proxy } = await start({
        catalog,
        capabilities: RESOURCE_CAPS,
        resources: callbacks,
      });

      const received = vi.fn();
      client.setNotificationHandler(ResourceListChangedNotificationSchema, received);

      await proxy.sendResourceListChanged();
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveBeenCalled();
    });

    it("sendResourceUpdated emits notifications/resources/updated with the same URI", async () => {
      const { catalog } = makeCatalog();
      const { callbacks } = buildResourceCallbacks();
      const { client, proxy } = await start({
        catalog,
        capabilities: RESOURCE_CAPS,
        resources: callbacks,
      });

      const received = vi.fn();
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, received);

      await proxy.sendResourceUpdated({ uri: "file:///a" });
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveBeenCalled();
      const notification = received.mock.calls[0]?.[0];
      expect(notification.params.uri).toBe("file:///a");
    });

    it("sendToolListChanged emits notifications/tools/list_changed to host", async () => {
      const { catalog } = makeCatalog();
      const { client, proxy } = await start({
        catalog,
        capabilities: { tools: { listChanged: true } },
      });

      const received = vi.fn();
      client.setNotificationHandler(ToolListChangedNotificationSchema, received);

      await proxy.sendToolListChanged();
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveBeenCalled();
    });
  });

  describe("prompts", () => {
    const PROMPT_CAPS: ServerCapabilities = {
      tools: { listChanged: true },
      prompts: { listChanged: true },
    };

    it("prompts/list returns what the callback provides", async () => {
      const { catalog } = makeCatalog();
      const listPrompts = vi.fn(() => [{ name: "summarize", description: "Summarize" }]);
      const getPrompt = vi.fn(async () => ({ messages: [] }));
      const { client } = await start({
        catalog,
        capabilities: PROMPT_CAPS,
        prompts: { listPrompts, getPrompt },
      });

      const result = await client.listPrompts();
      expect(listPrompts).toHaveBeenCalled();
      expect(result.prompts.map(p => p.name)).toEqual(["summarize"]);
    });

    it("prompts/get routes by name and arguments to the callback", async () => {
      const { catalog } = makeCatalog();
      const listPrompts = vi.fn(() => [{ name: "summarize", description: "Summarize" }]);
      const getPrompt = vi.fn(async () => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "ok" } }],
      }));
      const { client } = await start({
        catalog,
        capabilities: PROMPT_CAPS,
        prompts: { listPrompts, getPrompt },
      });

      await client.getPrompt({ name: "summarize", arguments: { topic: "AI" } });

      expect(getPrompt).toHaveBeenCalledWith(
        "summarize",
        { topic: "AI" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("sendPromptListChanged emits notifications/prompts/list_changed", async () => {
      const { catalog } = makeCatalog();
      const listPrompts = vi.fn(() => []);
      const getPrompt = vi.fn(async () => ({ messages: [] }));
      const { client, proxy } = await start({
        catalog,
        capabilities: PROMPT_CAPS,
        prompts: { listPrompts, getPrompt },
      });

      const received = vi.fn();
      client.setNotificationHandler(PromptListChangedNotificationSchema, received);

      await proxy.sendPromptListChanged();
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveBeenCalled();
    });
  });

  describe("completion", () => {
    it("completion/complete routes to the registered callback", async () => {
      const { catalog } = makeCatalog();
      const complete = vi.fn(async () => ({
        completion: { values: ["one", "two"], hasMore: false },
      }));
      const { client } = await start({
        catalog,
        capabilities: { tools: { listChanged: true }, completions: {} },
        complete,
      });

      const result = await client.complete({
        ref: { type: "ref/prompt", name: "summarize" },
        argument: { name: "topic", value: "A" },
      });

      expect(complete).toHaveBeenCalled();
      expect(result.completion.values).toEqual(["one", "two"]);
    });
  });

  describe("logging", () => {
    it("logging/setLevel routes to the registered callback", async () => {
      const { catalog } = makeCatalog();
      const setLoggingLevel = vi.fn(async () => {});
      const { client } = await start({
        catalog,
        capabilities: { tools: { listChanged: true }, logging: {} },
        setLoggingLevel,
      });

      await client.setLoggingLevel("warning");

      expect(setLoggingLevel).toHaveBeenCalledWith(
        "warning",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("sendLoggingMessage forwards a log message to the host", async () => {
      const { catalog } = makeCatalog();
      const { client, proxy } = await start({
        catalog,
        capabilities: { tools: { listChanged: true }, logging: {} },
        setLoggingLevel: async () => {},
      });

      const received = vi.fn();
      client.setNotificationHandler(LoggingMessageNotificationSchema, received);

      await proxy.sendLoggingMessage({ level: "info", logger: "test", data: "hello" });
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveBeenCalled();
      const notification = received.mock.calls[0]?.[0];
      expect(notification.params.data).toBe("hello");
    });
  });

  describe("server-initiated request forwarders", () => {
    it("forwardCreateMessage throws if buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(
        proxy.forwardCreateMessage(
          {
            messages: [],
            maxTokens: 100,
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/not built/);
    });

    it("forwardElicitInput throws if buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(
        proxy.forwardElicitInput(
          {
            message: "Need input",
            requestedSchema: { type: "object", properties: {} },
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/not built/);
    });

    it("forwardListRoots throws if buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(
        proxy.forwardListRoots(undefined, { signal: new AbortController().signal }),
      ).rejects.toThrow(/not built/);
    });
  });

  describe("onRootsListChanged", () => {
    it("invokes the callback when the host sends notifications/roots/list_changed", async () => {
      const { catalog } = makeCatalog();
      const onRootsListChanged = vi.fn();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: { listChanged: true } },
        callTool: async () => ({ content: [] }),
        onRootsListChanged,
      });
      const server = proxy.buildServer();

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: { roots: { listChanged: true } } },
      );
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      try {
        await client.sendRootsListChanged();
        await new Promise(resolve => setImmediate(resolve));

        expect(onRootsListChanged).toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("noop methods when not built", () => {
    it("sendResourceListChanged is a no-op when buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(proxy.sendResourceListChanged()).resolves.toBeUndefined();
    });

    it("sendResourceUpdated is a no-op when buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(proxy.sendResourceUpdated({ uri: "file:///x" })).resolves.toBeUndefined();
    });

    it("sendPromptListChanged is a no-op when buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(proxy.sendPromptListChanged()).resolves.toBeUndefined();
    });

    it("sendToolListChanged is a no-op when buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(proxy.sendToolListChanged()).resolves.toBeUndefined();
    });

    it("sendLoggingMessage is a no-op when buildServer has not been called", async () => {
      const { catalog } = makeCatalog();
      const proxy = new ProxyServer({
        catalog: () => catalog,
        capabilities: { tools: {} },
        callTool: async () => ({ content: [] }),
      });
      await expect(
        proxy.sendLoggingMessage({ level: "info", data: "hi" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("progress forwarding", () => {
    it("translates upstream progress events into host notifications with the host's progressToken", async () => {
      const { catalog } = makeCatalog();
      // The "upstream" callTool: simulate the SDK Client by invoking options.onprogress
      // with a sequence of progress events.
      const callTool: ToolCaller = async (_name, _input, options) => {
        options?.onprogress?.({ progress: 1, total: 3, message: "first" });
        options?.onprogress?.({ progress: 3, total: 3, message: "done" });
        return { content: [{ type: "text", text: "ok" }] };
      };
      const { client } = await start({ catalog, callTool });

      const received: Array<{ progressToken: string | number; progress: number }> = [];
      client.setNotificationHandler(ProgressNotificationSchema, async notification => {
        received.push({
          progressToken: notification.params.progressToken,
          progress: notification.params.progress,
        });
      });

      await client.callTool(
        { name: "use_tool", arguments: { tool_name: "known_tool", tool_input: {} } },
        undefined,
        {
          onprogress: () => {},
          // The SDK Client auto-assigns a progressToken when onprogress is set; this
          // is the token the host sees on its side. The proxy re-emits the upstream's
          // events under that same token.
        },
      );

      // Allow microtask queue to drain so the notifications round-trip back.
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveLength(2);
      expect(received[0]?.progress).toBe(1);
      expect(received[1]?.progress).toBe(3);
      // Both notifications use the same host-issued progress token.
      expect(received[0]?.progressToken).toBe(received[1]?.progressToken);
    });

    it("does not emit progress notifications when the host did not supply a progressToken", async () => {
      const { catalog } = makeCatalog();
      const callTool: ToolCaller = async (_name, _input, options) => {
        options?.onprogress?.({ progress: 1 });
        return { content: [] };
      };
      const { client } = await start({ catalog, callTool });

      const received = vi.fn();
      client.setNotificationHandler(ProgressNotificationSchema, received);

      await client.callTool({
        name: "use_tool",
        arguments: { tool_name: "known_tool", tool_input: {} },
      });
      await new Promise(resolve => setImmediate(resolve));

      expect(received).not.toHaveBeenCalled();
    });
  });
});
