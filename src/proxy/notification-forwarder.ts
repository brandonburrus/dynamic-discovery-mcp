import type { Prompt, Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import type { PromptRouter } from "./prompt-router.js";
import type { ResourceRouter } from "./resource-router.js";
import { ToolCatalog } from "./tool-catalog.js";
import type { LogMessageParams, UpstreamTool } from "./upstream-client.js";
import type { UpstreamRegistry } from "./upstream-registry.js";

/**
 * Callbacks the proxy uses to push notifications out to the host once an upstream
 * has emitted the equivalent inbound notification. The {@link NotificationForwarder}
 * is the seam between the upstream-side notification handlers (which it owns) and
 * the host-side outbound calls (which the caller provides).
 */
export type HostNotificationHandlers = {
  onToolsListChanged?: () => void | Promise<void>;
  onResourcesListChanged?: () => void | Promise<void>;
  onResourceUpdated?: (params: { uri: string }) => void | Promise<void>;
  onPromptsListChanged?: () => void | Promise<void>;
  onLogMessage?: (params: LogMessageParams) => void | Promise<void>;
};

/**
 * Translates upstream-emitted notifications into proxy-emitted notifications sent
 * to the host. For list-change notifications this includes re-fetching the affected
 * data from the originating upstream and updating the shared catalogs/routers before
 * propagating the change. For log messages it rewrites the `logger` field with the
 * `<mcp-name>/` prefix in config-file mode.
 *
 * The forwarder holds references to mutable state (the tool catalog, the routers)
 * and is expected to be co-owned with whatever assembles that state — typically the
 * Orchestrator. Catalog rebuilds are performed via the {@link buildToolCatalog}
 * callback so the Orchestrator stays the single owner of the catalog reference.
 */
export class NotificationForwarder {
  private hostHandlers: HostNotificationHandlers = {};

  constructor(
    private readonly registry: UpstreamRegistry,
    private readonly resourceRouter: () => ResourceRouter | null,
    private readonly promptRouter: () => PromptRouter | null,
    private readonly toolsByMcp: Map<string, UpstreamTool[]>,
    private readonly setToolCatalog: (catalog: ToolCatalog) => void,
    private readonly namespaced: boolean,
  ) {}

  setHostHandlers(handlers: HostNotificationHandlers): void {
    this.hostHandlers = handlers;
  }

  async handleToolsListChanged(mcpName: string): Promise<void> {
    const client = this.registry.get(mcpName);
    if (client === undefined) return;

    const tools = await client.listTools().catch(() => [] as UpstreamTool[]);
    this.toolsByMcp.set(mcpName, tools);

    const rebuilt = this.namespaced
      ? ToolCatalog.fromGrouped(this.toolsByMcp)
      : ToolCatalog.fromFlat([...this.toolsByMcp.values()][0] ?? []);
    this.setToolCatalog(rebuilt);

    await this.hostHandlers.onToolsListChanged?.();
  }

  async handleResourcesListChanged(mcpName: string): Promise<void> {
    const router = this.resourceRouter();
    const client = this.registry.get(mcpName);
    if (router === null || client === undefined) return;

    const [resources, templates] = await Promise.all([
      client.listResources().catch(() => [] as Resource[]),
      client.listResourceTemplates().catch(() => [] as ResourceTemplate[]),
    ]);
    router.setResources(mcpName, resources);
    router.setTemplates(mcpName, templates);

    await this.hostHandlers.onResourcesListChanged?.();
  }

  async handleResourceUpdated(params: { uri: string }): Promise<void> {
    await this.hostHandlers.onResourceUpdated?.(params);
  }

  async handlePromptsListChanged(mcpName: string): Promise<void> {
    const router = this.promptRouter();
    const client = this.registry.get(mcpName);
    if (router === null || client === undefined) return;

    const prompts = await client.listPrompts().catch(() => [] as Prompt[]);
    router.setPrompts(mcpName, prompts);

    await this.hostHandlers.onPromptsListChanged?.();
  }

  /**
   * Rewrites the upstream's `logger` field with the originating MCP's name as a
   * prefix so the host can attribute log lines, then forwards the message to the
   * host's log message handler.
   */
  async handleLogMessage(mcpName: string, params: LogMessageParams): Promise<void> {
    const handler = this.hostHandlers.onLogMessage;
    if (handler === undefined) return;

    if (!this.namespaced) {
      await handler(params);
      return;
    }

    const prefixed: LogMessageParams = {
      ...params,
      logger: params.logger === undefined ? mcpName : `${mcpName}/${params.logger}`,
    };
    await handler(prefixed);
  }
}
