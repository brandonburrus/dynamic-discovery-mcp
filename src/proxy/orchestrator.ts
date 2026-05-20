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
import { LazyRegistry } from "./lazy-registry.js";
import { NotificationForwarder, type HostNotificationHandlers } from "./notification-forwarder.js";
import { PromptRouter } from "./prompt-router.js";
import { ResourceRouter } from "./resource-router.js";
import { ToolCatalog } from "./tool-catalog.js";
import type { UpstreamCallOptions, UpstreamClient, UpstreamTool } from "./upstream-client.js";
import { UpstreamRegistry, type UpstreamConfig } from "./upstream-registry.js";

export type CallOptions = UpstreamCallOptions;

export type EagerMcpConfig = { transport: Transport };
export type LazyMcpConfig = { transport: Transport; description: string };

export type OrchestratorConfig = {
  /**
   * Upstream MCPs to connect eagerly at startup. In single-MCP (`--`) mode this must
   * contain exactly one entry and `namespaced` must be false.
   */
  eagerMcps: Map<string, EagerMcpConfig>;
  /**
   * Optional lazy upstream MCPs — those declared with a `description` field. Connection
   * is deferred until `loadMcp(name)` is called. The presence of any lazy entry enables
   * dynamic discovery (see SPEC.md § "Dynamic Discovery"). Must be empty in single-MCP
   * mode.
   *
   * The iteration order is preserved (config-file order) and is also used for router
   * priority alongside the eager entries — eager names come first, then lazy names, all
   * in their original config-file order.
   */
  lazyMcps?: Map<string, LazyMcpConfig>;
  /**
   * When true (config-file mode), tools are exposed as `<mcpName>/<toolName>` and routed
   * by splitting on the first `/`. When false (single-MCP `--` mode), tools are exposed
   * as bare names and routed to the sole upstream client.
   */
  namespaced: boolean;
  onTransportError?: (mcpName: string, error: Error) => void;
};

/**
 * Maximum consecutive failed `load_mcp` attempts per lazy MCP before the entry is
 * evicted from {@link LazyRegistry}. Once evicted, the agent receives "unknown
 * server" responses on subsequent calls and the entry vanishes from the
 * `<mcp_servers>` block. Three strikes is a balance: transient network or
 * startup hiccups are tolerated, but a permanently broken upstream stops burning
 * agent context forever.
 */
export const MAX_LOAD_ATTEMPTS = 3;

/**
 * Structured response returned by {@link Orchestrator.loadMcp}. Mirrors the schema
 * documented in SPEC.md for `load_mcp`'s output. Tool schemas are deliberately omitted
 * — `discover_tool` still owns the schema-retrieval surface; this listing is the
 * "what's in here" overview that lets the agent navigate post-load.
 */
export type LoadMcpResult = {
  mcp_name: string;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  resource_templates: Array<{
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  prompts: Array<{
    name: string;
    description?: string;
    arguments?: Prompt["arguments"];
  }>;
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
  private readonly lazyRegistry: LazyRegistry = new LazyRegistry();
  private readonly toolsByMcp: Map<string, UpstreamTool[]> = new Map();
  /**
   * In-flight loads, keyed by mcpName. Used by {@link loadMcp} to coalesce concurrent
   * calls for the same name onto a single underlying connection attempt — per SPEC.md
   * § "Dynamic Discovery > Concurrency".
   */
  private readonly inFlightLoads: Map<string, Promise<LoadMcpResult>> = new Map();
  private resourceRouter: ResourceRouter | null = null;
  private promptRouter: PromptRouter | null = null;
  private toolCatalog: ToolCatalog | null = null;
  private aggregatedCapabilities: ServerCapabilities | null = null;
  private serverRequestForwarders: OrchestratorServerRequestForwarders = {};
  private readonly forwarder: NotificationForwarder;

  constructor(config: OrchestratorConfig) {
    if (!config.namespaced && config.eagerMcps.size !== 1) {
      throw new Error(
        `Single-MCP (non-namespaced) mode requires exactly one upstream; got ${config.eagerMcps.size}.`,
      );
    }
    if (!config.namespaced && config.lazyMcps !== undefined && config.lazyMcps.size > 0) {
      throw new Error(
        "Single-MCP (non-namespaced) mode does not support lazy upstreams (descriptions).",
      );
    }
    this.config = config;
    this.forwarder = new NotificationForwarder(
      this.registry,
      () => this.resourceRouter,
      () => this.promptRouter,
      this.toolsByMcp,
      () => this.rebuildToolCatalog(),
      this.config.namespaced,
    );
  }

  setNotificationHandlers(handlers: OrchestratorNotificationHandlers): void {
    this.forwarder.setHostHandlers(handlers);
  }

  setServerRequestForwarders(forwarders: OrchestratorServerRequestForwarders): void {
    this.serverRequestForwarders = forwarders;
  }

  /**
   * True when the orchestrator was configured with at least one lazy upstream MCP.
   * The `index.ts` wiring uses this to decide whether to register the `load_mcp`
   * meta-tool with the host-facing {@link ProxyServer}.
   */
  get hasDynamicDiscovery(): boolean {
    return this.config.lazyMcps !== undefined && this.config.lazyMcps.size > 0;
  }

  async connect(): Promise<void> {
    // Router priority order includes lazy names too — eager entries populate now, lazy
    // entries populate as `loadMcp` calls land. This way first-wins collision rules
    // are defined entirely by config-file order and don't shift around when a lazy MCP
    // joins later.
    const allNames = [...this.config.eagerMcps.keys(), ...(this.config.lazyMcps?.keys() ?? [])];
    const resourceRouter = new ResourceRouter(allNames);
    const promptRouter = new PromptRouter(allNames);

    if (this.config.lazyMcps !== undefined) {
      for (const [name, { transport, description }] of this.config.lazyMcps) {
        this.lazyRegistry.register(name, { transport, description });
      }
    }

    const upstreamEntries: ReadonlyArray<readonly [string, UpstreamConfig]> = [
      ...this.config.eagerMcps,
    ].map(([mcpName, { transport }]) => [mcpName, this.buildUpstreamConfig(mcpName, transport)]);

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

    this.resourceRouter = resourceRouter;
    this.promptRouter = promptRouter;
    this.aggregatedCapabilities = aggregateCapabilities(capabilityList);
    this.rebuildToolCatalog();

    logCollisions(resourceRouter, promptRouter);
  }

  async disconnectAll(): Promise<void> {
    await this.registry.disconnectAll();
    this.toolsByMcp.clear();
    this.toolCatalog = null;
    this.aggregatedCapabilities = null;
    this.resourceRouter = null;
    this.promptRouter = null;
    this.inFlightLoads.clear();
  }

  // === Dynamic discovery ===

  /**
   * Loads a lazy upstream MCP on demand. Implements the semantics of SPEC.md §
   * "Tools > load_mcp" and § "Dynamic Discovery > Lifecycle of a Lazy MCP":
   *
   * - Already-loaded (eager or previously-loaded lazy) names succeed as a no-op
   *   returning the current listing; no notifications fire.
   * - Unknown names throw an error that hints at the still-lazy alternatives.
   * - Concurrent calls for the same name coalesce onto the same in-flight load.
   * - A failure during connect/initialize/catalog-query rolls back atomically:
   *   the upstream is disconnected, the lazy entry stays registered, no host
   *   notifications fire.
   * - On success the loaded MCP is promoted into the connected registry, its
   *   tools/resources/prompts populate the routers, the discover_tool catalog
   *   is regenerated, and the host receives `tools/list_changed` plus
   *   `resources/list_changed` and/or `prompts/list_changed` for any non-empty
   *   surface the MCP contributed.
   */
  async loadMcp(mcpName: string): Promise<LoadMcpResult> {
    if (this.registry.get(mcpName) !== undefined) {
      // Already connected — either eager at startup or previously loaded. Idempotent
      // no-op: return current listing without firing notifications.
      return this.getListing(mcpName);
    }

    const inFlight = this.inFlightLoads.get(mcpName);
    if (inFlight !== undefined) {
      return inFlight;
    }

    if (!this.lazyRegistry.has(mcpName)) {
      const lazyNames = this.lazyRegistry.names().join(", ");
      const hint = lazyNames.length > 0 ? lazyNames : "(none)";
      throw new Error(`Unknown MCP server: "${mcpName}". Available servers to load: ${hint}`);
    }

    const loadPromise = this.runLoadPipeline(mcpName).finally(() => {
      this.inFlightLoads.delete(mcpName);
    });
    this.inFlightLoads.set(mcpName, loadPromise);
    return loadPromise;
  }

  private async runLoadPipeline(mcpName: string): Promise<LoadMcpResult> {
    const entry = this.lazyRegistry.get(mcpName);
    if (entry === undefined) {
      throw new Error(`Internal error: lazy entry "${mcpName}" vanished mid-load.`);
    }

    const client = await this.registry.connectOne(
      mcpName,
      this.buildUpstreamConfig(mcpName, entry.transport),
    );

    let tools: UpstreamTool[];
    let resources: Resource[] = [];
    let templates: ResourceTemplate[] = [];
    let prompts: Prompt[] = [];
    let caps: ServerCapabilities | undefined;
    try {
      caps = client.getCapabilities();
      tools = await client.listTools();

      if (caps?.resources !== undefined) {
        [resources, templates] = await Promise.all([
          client.listResources(),
          client.listResourceTemplates(),
        ]);
      }
      if (caps?.prompts !== undefined) {
        prompts = await client.listPrompts();
      }
    } catch (error) {
      // Roll back atomically: drop the half-loaded upstream. Track the failure
      // against the retry budget — once exhausted, evict the lazy entry entirely
      // and emit `tools/list_changed` so the host sees `<mcp_servers>` update.
      await this.registry.deleteOne(mcpName);
      const failures = this.lazyRegistry.recordFailure(mcpName);
      if (failures >= MAX_LOAD_ATTEMPTS) {
        this.lazyRegistry.take(mcpName);
        this.rebuildToolCatalog();
        await this.forwarder.notifyToolsListChanged();
        const base = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to load "${mcpName}" after ${failures} attempts; the server will no longer be offered for discovery. Underlying error: ${base}`,
        );
      }
      throw error;
    }

    // Commit phase: from here on every step is purely local mutation, so the load is
    // atomic in practice — we've succeeded in talking to the upstream, and updating
    // local state cannot fail in a way that leaves us with a phantom load.
    this.lazyRegistry.take(mcpName);
    this.toolsByMcp.set(mcpName, tools);
    const resourceRouter = this.requireResourceRouter();
    const promptRouter = this.requirePromptRouter();
    if (caps?.resources !== undefined) {
      resourceRouter.setResources(mcpName, resources);
      resourceRouter.setTemplates(mcpName, templates);
    }
    if (caps?.prompts !== undefined) {
      promptRouter.setPrompts(mcpName, prompts);
    }
    this.rebuildToolCatalog();

    // Emit notifications. `tools/list_changed` always — the catalog and the
    // `<mcp_servers>` block both changed. Resource/prompt notifications are emitted
    // only when the MCP contributed entries (per SPEC.md § "load_mcp").
    await this.forwarder.notifyToolsListChanged();
    if (caps?.resources !== undefined && (resources.length > 0 || templates.length > 0)) {
      await this.forwarder.notifyResourcesListChanged();
    }
    if (caps?.prompts !== undefined && prompts.length > 0) {
      await this.forwarder.notifyPromptsListChanged();
    }

    return this.getListing(mcpName);
  }

  /**
   * Builds the structured response shape documented for `load_mcp` from existing
   * per-MCP state. Pulled out into a helper so the no-op path (already-loaded)
   * and the success path share one source of truth.
   */
  private getListing(mcpName: string): LoadMcpResult {
    const tools = this.toolsByMcp.get(mcpName) ?? [];
    const namespacedToolName = (name: string): string =>
      this.config.namespaced ? `${mcpName}/${name}` : name;

    const resources = this.resourceRouter?.resourcesFor(mcpName) ?? [];
    const templates = this.resourceRouter?.templatesFor(mcpName) ?? [];
    const prompts = this.promptRouter?.promptsFor(mcpName) ?? [];

    return {
      mcp_name: mcpName,
      tools: tools.map(tool => ({
        name: namespacedToolName(tool.name),
        description: tool.description,
      })),
      resources: resources.map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
      resource_templates: templates.map(template => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType,
      })),
      prompts: prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
    };
  }

  // === Internal helpers used by connect() and loadMcp() ===

  private buildUpstreamConfig(mcpName: string, transport: Transport): UpstreamConfig {
    return {
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
    };
  }

  /**
   * Rebuilds the `ToolCatalog` from current state. Called whenever `toolsByMcp` or the
   * lazy-registry membership changes — including initial connect, upstream-emitted
   * `tools/list_changed`, and successful `loadMcp`.
   */
  private rebuildToolCatalog(): void {
    if (this.config.namespaced) {
      this.toolCatalog = ToolCatalog.fromGroupedWithLazy(
        this.toolsByMcp,
        this.lazyRegistry.descriptions(),
      );
    } else {
      this.toolCatalog = ToolCatalog.fromFlat([...this.toolsByMcp.values()][0] ?? []);
    }
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
