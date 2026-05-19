import process from "node:process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
  GetPromptResult,
  ListRootsRequest,
  ListRootsResult,
  LoggingLevel,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { aggregateCapabilities } from "./capability-aggregator.js";
import { NotificationForwarder, type HostNotificationHandlers } from "./notification-forwarder.js";
import { PromptRouter } from "./prompt-router.js";
import { ResourceRouter } from "./resource-router.js";
import { ToolCatalog } from "./tool-catalog.js";
import type { UpstreamCallOptions, UpstreamClient, UpstreamTool } from "./upstream-client.js";
import { UpstreamRegistry, type UpstreamConfig } from "./upstream-registry.js";

export type CallOptions = UpstreamCallOptions;

export type OrchestratorConfig = {
  mcps: Map<string, { transport: Transport }>;
  /**
   * When true (config-file mode), tools are exposed as `<mcpName>/<toolName>` and routed
   * by splitting on the first `/`. When false (single-MCP `--` mode), tools are exposed
   * as bare names and routed to the sole upstream client. In single mode `mcps` must
   * contain exactly one entry.
   */
  namespaced: boolean;
  onTransportError?: (mcpName: string, error: Error) => void;
};

export type OrchestratorNotificationHandlers = HostNotificationHandlers;

/**
 * Forwarders for upstream-initiated requests. The Orchestrator wires each upstream
 * client's incoming request handlers to call into these so the proxy can relay the
 * request to the host. `signal` is the upstream's request-abort signal — passing it
 * through to the host call propagates cancellation if the upstream cancels.
 */
export type OrchestratorServerRequestForwarders = {
  onCreateMessage?: (
    params: CreateMessageRequest["params"],
    options: { signal: AbortSignal },
  ) => Promise<CreateMessageResult>;
  onElicitInput?: (
    params: ElicitRequest["params"],
    options: { signal: AbortSignal },
  ) => Promise<ElicitResult>;
  onListRoots?: (
    params: ListRootsRequest["params"],
    options: { signal: AbortSignal },
  ) => Promise<ListRootsResult>;
};

/**
 * Composition root for the proxy hub. Composes {@link UpstreamRegistry} (lifecycle),
 * {@link NotificationForwarder} (upstream→host notification translation), and the
 * routers/catalogs (forward-direction request routing). Public surface is the same
 * across single-MCP and config-file modes; the `namespaced` flag toggles tool-naming
 * behavior internally.
 */
export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly registry: UpstreamRegistry = new UpstreamRegistry();
  private readonly toolsByMcp: Map<string, UpstreamTool[]> = new Map();
  private resourceRouter: ResourceRouter | null = null;
  private promptRouter: PromptRouter | null = null;
  private toolCatalog: ToolCatalog | null = null;
  private aggregatedCapabilities: ServerCapabilities | null = null;
  private serverRequestForwarders: OrchestratorServerRequestForwarders = {};
  private readonly forwarder: NotificationForwarder;

  constructor(config: OrchestratorConfig) {
    if (!config.namespaced && config.mcps.size !== 1) {
      throw new Error(
        `Single-MCP (non-namespaced) mode requires exactly one upstream; got ${config.mcps.size}.`,
      );
    }
    this.config = config;
    this.forwarder = new NotificationForwarder(
      this.registry,
      () => this.resourceRouter,
      () => this.promptRouter,
      this.toolsByMcp,
      catalog => {
        this.toolCatalog = catalog;
      },
      this.config.namespaced,
    );
  }

  setNotificationHandlers(handlers: OrchestratorNotificationHandlers): void {
    this.forwarder.setHostHandlers(handlers);
  }

  setServerRequestForwarders(forwarders: OrchestratorServerRequestForwarders): void {
    this.serverRequestForwarders = forwarders;
  }

  async connect(): Promise<void> {
    const resourceRouter = new ResourceRouter([...this.config.mcps.keys()]);
    const promptRouter = new PromptRouter([...this.config.mcps.keys()]);

    const upstreamEntries: ReadonlyArray<readonly [string, UpstreamConfig]> = [
      ...this.config.mcps,
    ].map(([mcpName, { transport }]) => [
      mcpName,
      {
        transport,
        onTransportError: (error: Error) => {
          this.config.onTransportError?.(mcpName, error);
        },
        notifications: {
          onToolsListChanged: () => this.forwarder.handleToolsListChanged(mcpName),
          onResourcesListChanged: () => this.forwarder.handleResourcesListChanged(mcpName),
          onResourceUpdated: params => this.forwarder.handleResourceUpdated(params),
          onPromptsListChanged: () => this.forwarder.handlePromptsListChanged(mcpName),
          onLogMessage: params => this.forwarder.handleLogMessage(mcpName, params),
        },
        serverRequests: {
          onCreateMessage: (params, opts) => this.forwardCreateMessage(params, opts),
          onElicitInput: (params, opts) => this.forwardElicitInput(params, opts),
          onListRoots: (params, opts) => this.forwardListRoots(params, opts),
        },
      },
    ]);

    await this.registry.connectAll(upstreamEntries);

    const capabilityList: (ServerCapabilities | undefined)[] = [];
    this.toolsByMcp.clear();

    for (const [mcpName, client] of this.registry.entries()) {
      const caps = client.getCapabilities();
      capabilityList.push(caps);

      const tools = await client.listTools();
      this.toolsByMcp.set(mcpName, tools);

      if (caps?.resources !== undefined) {
        const [resources, templates] = await Promise.all([
          client.listResources().catch(() => [] as Resource[]),
          client.listResourceTemplates().catch(() => [] as ResourceTemplate[]),
        ]);
        resourceRouter.setResources(mcpName, resources);
        resourceRouter.setTemplates(mcpName, templates);
      }
      if (caps?.prompts !== undefined) {
        const prompts = await client.listPrompts().catch(() => [] as Prompt[]);
        promptRouter.setPrompts(mcpName, prompts);
      }
    }

    this.toolCatalog = this.config.namespaced
      ? ToolCatalog.fromGrouped(this.toolsByMcp)
      : ToolCatalog.fromFlat([...this.toolsByMcp.values()][0] ?? []);
    this.aggregatedCapabilities = aggregateCapabilities(capabilityList);
    this.resourceRouter = resourceRouter;
    this.promptRouter = promptRouter;

    logCollisions(resourceRouter, promptRouter);
  }

  async disconnectAll(): Promise<void> {
    await this.registry.disconnectAll();
    this.toolsByMcp.clear();
    this.toolCatalog = null;
    this.aggregatedCapabilities = null;
    this.resourceRouter = null;
    this.promptRouter = null;
  }

  get catalog(): ToolCatalog {
    if (this.toolCatalog === null) {
      throw new Error("Orchestrator is not connected. Call connect() first.");
    }
    return this.toolCatalog;
  }

  get capabilities(): ServerCapabilities {
    if (this.aggregatedCapabilities === null) {
      throw new Error("Orchestrator is not connected. Call connect() first.");
    }
    return this.aggregatedCapabilities;
  }

  // === Forward-direction request routing ===

  async callTool(
    displayName: string,
    input: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<CallToolResult> {
    if (this.config.namespaced) {
      const { mcpName, toolName } = splitNamespacedName(displayName, this.registry.names());
      return this.requireClient(mcpName, "tool").callTool(toolName, input, options);
    }

    const sole = this.registry.sole();
    if (sole === undefined) {
      throw new Error("Orchestrator is not connected. Call connect() first.");
    }
    return sole.callTool(displayName, input, options);
  }

  listResources(): Resource[] {
    return this.requireResourceRouter().aggregatedResources();
  }

  listResourceTemplates(): ResourceTemplate[] {
    return this.requireResourceRouter().aggregatedTemplates();
  }

  async readResource(uri: string, options?: CallOptions): Promise<ReadResourceResult> {
    return this.resolveResourceOwner(uri).readResource(uri, options);
  }

  async subscribeResource(uri: string, options?: CallOptions): Promise<void> {
    await this.resolveResourceOwner(uri).subscribeResource(uri, options);
  }

  async unsubscribeResource(uri: string, options?: CallOptions): Promise<void> {
    await this.resolveResourceOwner(uri).unsubscribeResource(uri, options);
  }

  listPrompts(): Prompt[] {
    return this.requirePromptRouter().aggregatedPrompts();
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    options?: CallOptions,
  ): Promise<GetPromptResult> {
    return this.resolvePromptOwner(name).getPrompt(name, args, options);
  }

  async complete(
    params: CompleteRequest["params"],
    options?: CallOptions,
  ): Promise<CompleteResult> {
    const client = this.resolveCompletionTarget(params.ref);
    return client.complete(params, options);
  }

  // === Broadcasts ===

  /**
   * Broadcasts a `logging/setLevel` request to every upstream advertising the logging
   * capability. Errors from individual upstreams are swallowed so a single misbehaving
   * upstream cannot break the broadcast for others; failures are written to stderr.
   */
  async setLoggingLevel(level: LoggingLevel, options?: CallOptions): Promise<void> {
    await this.broadcastAsync(
      client =>
        client.getCapabilities()?.logging !== undefined
          ? client.setLoggingLevel(level, options)
          : Promise.resolve(),
      "setLoggingLevel",
    );
  }

  /**
   * Broadcasts `notifications/roots/list_changed` to every connected upstream — the
   * proxy declares roots capability uniformly to all upstreams so every one of them
   * may have requested roots and needs to know the list changed.
   */
  async broadcastRootsListChanged(): Promise<void> {
    await this.broadcastAsync(client => client.sendRootsListChanged(), "sendRootsListChanged");
  }

  // === Server-initiated request forwarders (upstream → host) ===

  private async forwardCreateMessage(
    params: CreateMessageRequest["params"],
    options: { signal: AbortSignal },
  ): Promise<CreateMessageResult> {
    const handler = this.serverRequestForwarders.onCreateMessage;
    if (handler === undefined) {
      throw new Error("Proxy does not support sampling: host has not registered a handler.");
    }
    return handler(params, options);
  }

  private async forwardElicitInput(
    params: ElicitRequest["params"],
    options: { signal: AbortSignal },
  ): Promise<ElicitResult> {
    const handler = this.serverRequestForwarders.onElicitInput;
    if (handler === undefined) {
      throw new Error("Proxy does not support elicitation: host has not registered a handler.");
    }
    return handler(params, options);
  }

  private async forwardListRoots(
    params: ListRootsRequest["params"],
    options: { signal: AbortSignal },
  ): Promise<ListRootsResult> {
    const handler = this.serverRequestForwarders.onListRoots;
    if (handler === undefined) {
      throw new Error("Proxy does not support roots: host has not registered a handler.");
    }
    return handler(params, options);
  }

  // === Internal helpers ===

  private requireResourceRouter(): ResourceRouter {
    if (this.resourceRouter === null) {
      throw new Error("Orchestrator is not connected. Call connect() first.");
    }
    return this.resourceRouter;
  }

  private requirePromptRouter(): PromptRouter {
    if (this.promptRouter === null) {
      throw new Error("Orchestrator is not connected. Call connect() first.");
    }
    return this.promptRouter;
  }

  private resolveResourceOwner(uri: string): UpstreamClient {
    const owner = this.requireResourceRouter().ownerOf(uri);
    if (owner === undefined) {
      throw new Error(`Unknown resource URI: "${uri}". No upstream MCP advertises it.`);
    }
    return this.requireClient(owner, "resource");
  }

  private resolvePromptOwner(name: string): UpstreamClient {
    const owner = this.requirePromptRouter().ownerOf(name);
    if (owner === undefined) {
      throw new Error(`Unknown prompt: "${name}". No upstream MCP advertises it.`);
    }
    return this.requireClient(owner, "prompt");
  }

  private resolveCompletionTarget(ref: CompleteRequest["params"]["ref"]): UpstreamClient {
    if (ref.type === "ref/prompt") {
      return this.resolvePromptOwner(ref.name);
    }
    if (ref.type === "ref/resource") {
      return this.resolveResourceOwner(ref.uri);
    }
    const unknownRef: { type: string } = ref;
    throw new Error(`Unsupported completion ref type: "${unknownRef.type}"`);
  }

  private requireClient(mcpName: string, role: string): UpstreamClient {
    const client = this.registry.get(mcpName);
    if (client === undefined) {
      throw new Error(`Internal error: ${role} owner "${mcpName}" has no connected client.`);
    }
    return client;
  }

  private async broadcastAsync(
    action: (client: UpstreamClient) => Promise<void>,
    label: string,
  ): Promise<void> {
    const targets: Promise<void>[] = [];
    for (const [mcpName, client] of this.registry.entries()) {
      targets.push(
        action(client).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`dynmcp: ${label} failed for "${mcpName}": ${message}\n`);
        }),
      );
    }
    await Promise.all(targets);
  }
}

function splitNamespacedName(
  namespacedName: string,
  knownMcpNames: readonly string[],
): { mcpName: string; toolName: string } {
  const separatorIndex = namespacedName.indexOf("/");
  if (separatorIndex === -1) {
    throw new Error(
      `Invalid namespaced tool name: "${namespacedName}". Expected format: "mcpName/toolName".`,
    );
  }

  const mcpName = namespacedName.slice(0, separatorIndex);
  const toolName = namespacedName.slice(separatorIndex + 1);

  if (!knownMcpNames.includes(mcpName)) {
    const available = [...knownMcpNames].sort().join(", ");
    throw new Error(`Unknown MCP: "${mcpName}". Available MCPs: ${available}`);
  }

  return { mcpName, toolName };
}

function logCollisions(resourceRouter: ResourceRouter, promptRouter: PromptRouter): void {
  for (const collision of resourceRouter.collisions()) {
    process.stderr.write(
      `dynmcp: resource URI collision: "${collision.uri}" is provided by ` +
        `"${collision.chosen}" and "${collision.shadowed}"; routing to "${collision.chosen}".\n`,
    );
  }
  for (const collision of promptRouter.collisions()) {
    process.stderr.write(
      `dynmcp: prompt name collision: "${collision.name}" is provided by ` +
        `"${collision.chosen}" and "${collision.shadowed}"; routing to "${collision.chosen}".\n`,
    );
  }
}
