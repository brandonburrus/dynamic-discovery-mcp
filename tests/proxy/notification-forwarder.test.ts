import type { Prompt, Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationForwarder } from "../../src/proxy/notification-forwarder.js";
import { PromptRouter } from "../../src/proxy/prompt-router.js";
import { ResourceRouter } from "../../src/proxy/resource-router.js";
import type { LogMessageParams, UpstreamTool } from "../../src/proxy/upstream-client.js";
import type { UpstreamRegistry } from "../../src/proxy/upstream-registry.js";

type FakeUpstreamClient = {
  listTools: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  listResourceTemplates: ReturnType<typeof vi.fn>;
  listPrompts: ReturnType<typeof vi.fn>;
};

function makeFakeClient(overrides: Partial<FakeUpstreamClient> = {}): FakeUpstreamClient {
  return {
    listTools: vi.fn().mockResolvedValue([] as UpstreamTool[]),
    listResources: vi.fn().mockResolvedValue([] as Resource[]),
    listResourceTemplates: vi.fn().mockResolvedValue([] as ResourceTemplate[]),
    listPrompts: vi.fn().mockResolvedValue([] as Prompt[]),
    ...overrides,
  };
}

function makeRegistry(clients: Map<string, FakeUpstreamClient>): UpstreamRegistry {
  return {
    get: (mcpName: string) => clients.get(mcpName),
  } as unknown as UpstreamRegistry;
}

describe("NotificationForwarder", () => {
  let clients: Map<string, FakeUpstreamClient>;
  let resourceRouter: ResourceRouter;
  let promptRouter: PromptRouter;
  let toolsByMcp: Map<string, UpstreamTool[]>;
  // Catalog rebuilds are owned by the orchestrator now — the forwarder only triggers
  // them via this callback. We count invocations to assert that the trigger fired.
  let rebuildCount: number;

  beforeEach(() => {
    clients = new Map();
    resourceRouter = new ResourceRouter(["a", "b"]);
    promptRouter = new PromptRouter(["a", "b"]);
    toolsByMcp = new Map();
    rebuildCount = 0;
  });

  function makeForwarder(namespaced = true): NotificationForwarder {
    return new NotificationForwarder(
      makeRegistry(clients),
      () => resourceRouter,
      () => promptRouter,
      toolsByMcp,
      () => {
        rebuildCount++;
      },
      namespaced,
    );
  }

  describe("handleToolsListChanged", () => {
    it("re-fetches tools from the affected upstream and rebuilds the namespaced catalog", async () => {
      const client = makeFakeClient({
        listTools: vi
          .fn()
          .mockResolvedValue([
            { name: "tool_a", description: "A", inputSchema: {} },
          ] as UpstreamTool[]),
      });
      clients.set("a", client);
      toolsByMcp.set("a", []);

      const onToolsListChanged = vi.fn();
      const forwarder = makeForwarder(true);
      forwarder.setHostHandlers({ onToolsListChanged });

      await forwarder.handleToolsListChanged("a");

      expect(client.listTools).toHaveBeenCalledOnce();
      expect(toolsByMcp.get("a")).toEqual([{ name: "tool_a", description: "A", inputSchema: {} }]);
      expect(rebuildCount).toBe(1);
      expect(onToolsListChanged).toHaveBeenCalledOnce();
    });

    it("triggers a catalog rebuild after refetching, regardless of namespacing", async () => {
      const client = makeFakeClient({
        listTools: vi
          .fn()
          .mockResolvedValue([
            { name: "tool_a", description: "A", inputSchema: {} },
          ] as UpstreamTool[]),
      });
      clients.set("only", client);
      toolsByMcp.set("only", []);

      const forwarder = makeForwarder(false);
      await forwarder.handleToolsListChanged("only");

      // Catalog composition is the orchestrator's responsibility now — the forwarder's
      // contract is just "I refetched and asked for a rebuild".
      expect(rebuildCount).toBe(1);
      expect(toolsByMcp.get("only")).toEqual([
        { name: "tool_a", description: "A", inputSchema: {} },
      ]);
    });

    it("no-ops when the mcpName is unknown", async () => {
      const onToolsListChanged = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onToolsListChanged });

      await forwarder.handleToolsListChanged("ghost");

      expect(onToolsListChanged).not.toHaveBeenCalled();
      expect(rebuildCount).toBe(0);
    });

    it("swallows listTools rejections and treats the upstream as having no tools", async () => {
      const client = makeFakeClient({
        listTools: vi.fn().mockRejectedValue(new Error("network down")),
      });
      clients.set("a", client);
      toolsByMcp.set("a", [{ name: "tool_a", description: "", inputSchema: {} }]);

      const onToolsListChanged = vi.fn();
      const forwarder = makeForwarder(true);
      forwarder.setHostHandlers({ onToolsListChanged });

      await forwarder.handleToolsListChanged("a");

      expect(toolsByMcp.get("a")).toEqual([]);
      expect(onToolsListChanged).toHaveBeenCalledOnce();
    });
  });

  describe("handleResourcesListChanged", () => {
    it("re-fetches resources and templates and updates the router", async () => {
      const client = makeFakeClient({
        listResources: vi.fn().mockResolvedValue([{ uri: "file:///a", name: "A" }] as Resource[]),
        listResourceTemplates: vi
          .fn()
          .mockResolvedValue([{ uriTemplate: "file:///{path}", name: "FS" }] as ResourceTemplate[]),
      });
      clients.set("a", client);

      const onResourcesListChanged = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onResourcesListChanged });

      await forwarder.handleResourcesListChanged("a");

      expect(resourceRouter.ownerOf("file:///a")).toBe("a");
      expect(resourceRouter.aggregatedTemplates()).toHaveLength(1);
      expect(onResourcesListChanged).toHaveBeenCalledOnce();
    });

    it("no-ops when the mcpName is unknown", async () => {
      const handler = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onResourcesListChanged: handler });

      await forwarder.handleResourcesListChanged("ghost");

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("handleResourceUpdated", () => {
    it("forwards the params verbatim to the host handler", async () => {
      const onResourceUpdated = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onResourceUpdated });

      await forwarder.handleResourceUpdated({ uri: "file:///foo" });

      expect(onResourceUpdated).toHaveBeenCalledWith({ uri: "file:///foo" });
    });

    it("no-ops when no host handler is registered", async () => {
      const forwarder = makeForwarder();
      await expect(
        forwarder.handleResourceUpdated({ uri: "file:///foo" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("handlePromptsListChanged", () => {
    it("re-fetches prompts and updates the router", async () => {
      const client = makeFakeClient({
        listPrompts: vi
          .fn()
          .mockResolvedValue([{ name: "summarize", description: "Summarize" }] as Prompt[]),
      });
      clients.set("a", client);

      const onPromptsListChanged = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onPromptsListChanged });

      await forwarder.handlePromptsListChanged("a");

      expect(promptRouter.ownerOf("summarize")).toBe("a");
      expect(onPromptsListChanged).toHaveBeenCalledOnce();
    });

    it("no-ops when the mcpName is unknown", async () => {
      const handler = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onPromptsListChanged: handler });

      await forwarder.handlePromptsListChanged("ghost");

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("handleLogMessage", () => {
    it("forwards verbatim in non-namespaced mode", async () => {
      const onLogMessage = vi.fn();
      const forwarder = makeForwarder(false);
      forwarder.setHostHandlers({ onLogMessage });

      const params: LogMessageParams = { level: "info", logger: "network", data: "msg" };
      await forwarder.handleLogMessage("only", params);

      expect(onLogMessage).toHaveBeenCalledWith(params);
    });

    it("prefixes the logger field with <mcp-name>/ in namespaced mode", async () => {
      const onLogMessage = vi.fn();
      const forwarder = makeForwarder(true);
      forwarder.setHostHandlers({ onLogMessage });

      await forwarder.handleLogMessage("chrome", {
        level: "info",
        logger: "network",
        data: "msg",
      });

      expect(onLogMessage).toHaveBeenCalledWith(
        expect.objectContaining({ logger: "chrome/network" }),
      );
    });

    it("sets the logger to the mcp name when the upstream omitted the logger field", async () => {
      const onLogMessage = vi.fn();
      const forwarder = makeForwarder(true);
      forwarder.setHostHandlers({ onLogMessage });

      await forwarder.handleLogMessage("chrome", { level: "warning", data: "msg" });

      expect(onLogMessage).toHaveBeenCalledWith(expect.objectContaining({ logger: "chrome" }));
    });

    it("no-ops when no host handler is registered", async () => {
      const forwarder = makeForwarder();
      await expect(
        forwarder.handleLogMessage("a", { level: "info", data: "msg" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("notifyXListChanged (emit-only helpers)", () => {
    it("notifyToolsListChanged invokes the host handler without touching toolsByMcp or the registry", async () => {
      const onToolsListChanged = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onToolsListChanged });
      toolsByMcp.set("a", [{ name: "x", description: "", inputSchema: {} }]);

      await forwarder.notifyToolsListChanged();

      expect(onToolsListChanged).toHaveBeenCalledOnce();
      // Critically — no refetch, no rebuild trigger. The orchestrator that owns
      // load_mcp already populated state directly before calling this helper.
      expect(rebuildCount).toBe(0);
      expect(toolsByMcp.get("a")).toEqual([{ name: "x", description: "", inputSchema: {} }]);
    });

    it("notifyResourcesListChanged invokes the host handler only", async () => {
      const onResourcesListChanged = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onResourcesListChanged });

      await forwarder.notifyResourcesListChanged();

      expect(onResourcesListChanged).toHaveBeenCalledOnce();
    });

    it("notifyPromptsListChanged invokes the host handler only", async () => {
      const onPromptsListChanged = vi.fn();
      const forwarder = makeForwarder();
      forwarder.setHostHandlers({ onPromptsListChanged });

      await forwarder.notifyPromptsListChanged();

      expect(onPromptsListChanged).toHaveBeenCalledOnce();
    });

    it("notifyXListChanged silently no-ops when no host handler is registered", async () => {
      const forwarder = makeForwarder();
      await expect(forwarder.notifyToolsListChanged()).resolves.toBeUndefined();
      await expect(forwarder.notifyResourcesListChanged()).resolves.toBeUndefined();
      await expect(forwarder.notifyPromptsListChanged()).resolves.toBeUndefined();
    });
  });

  describe("with null routers", () => {
    it("handleResourcesListChanged no-ops when the resource router is null", async () => {
      const client = makeFakeClient();
      clients.set("a", client);

      const onResourcesListChanged = vi.fn();
      const forwarder = new NotificationForwarder(
        makeRegistry(clients),
        () => null,
        () => promptRouter,
        toolsByMcp,
        () => {},
        true,
      );
      forwarder.setHostHandlers({ onResourcesListChanged });

      await forwarder.handleResourcesListChanged("a");

      expect(onResourcesListChanged).not.toHaveBeenCalled();
    });

    it("handlePromptsListChanged no-ops when the prompt router is null", async () => {
      const client = makeFakeClient();
      clients.set("a", client);

      const onPromptsListChanged = vi.fn();
      const forwarder = new NotificationForwarder(
        makeRegistry(clients),
        () => resourceRouter,
        () => null,
        toolsByMcp,
        () => {},
        true,
      );
      forwarder.setHostHandlers({ onPromptsListChanged });

      await forwarder.handlePromptsListChanged("a");

      expect(onPromptsListChanged).not.toHaveBeenCalled();
    });
  });
});
