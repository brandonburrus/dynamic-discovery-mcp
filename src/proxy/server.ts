import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  CompleteRequestSchema,
  type CompleteRequest,
  type CompleteResult,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ElicitRequest,
  type ElicitResult,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type ListPromptsResult,
  ListResourcesRequestSchema,
  type ListResourcesResult,
  ListResourceTemplatesRequestSchema,
  type ListResourceTemplatesResult,
  type ListRootsRequest,
  type ListRootsResult,
  ListToolsRequestSchema,
  type LoggingLevel,
  type LoggingMessageNotification,
  type Prompt,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  RootsListChangedNotificationSchema,
  type ServerCapabilities,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import type { ToolCatalog } from "./tool-catalog.js";

export type ProgressEvent = {
  progress: number;
  total?: number;
  message?: string;
};

/**
 * Per-call options forwarded by the proxy server's request handlers to the orchestrator.
 *
 * - `signal`: propagates host-side cancellation through to the upstream call. When the
 *   host cancels its incoming request, the SDK client emits `notifications/cancelled`
 *   to the upstream.
 * - `onprogress`: invoked when the upstream emits a `notifications/progress` for the
 *   in-flight call. The proxy server uses this to translate upstream progress events
 *   into host-facing notifications under the host's original progress token.
 */
export type ProxyCallOptions = {
  signal?: AbortSignal;
  onprogress?: (progress: ProgressEvent) => void;
};

export type ToolCaller = (
  name: string,
  input: Record<string, unknown>,
  options?: ProxyCallOptions,
) => Promise<CallToolResult>;

export type ResourceCallbacks = {
  listResources: () => Resource[];
  listResourceTemplates: () => ResourceTemplate[];
  readResource: (uri: string, options?: ProxyCallOptions) => Promise<ReadResourceResult>;
  subscribeResource: (uri: string, options?: ProxyCallOptions) => Promise<void>;
  unsubscribeResource: (uri: string, options?: ProxyCallOptions) => Promise<void>;
};

export type PromptCallbacks = {
  listPrompts: () => Prompt[];
  getPrompt: (
    name: string,
    args?: Record<string, string>,
    options?: ProxyCallOptions,
  ) => Promise<GetPromptResult>;
};

export type CompletionCallback = (
  params: CompleteRequest["params"],
  options?: ProxyCallOptions,
) => Promise<CompleteResult>;

export type LoggingSetLevelCallback = (
  level: LoggingLevel,
  options?: ProxyCallOptions,
) => Promise<void>;

/**
 * Result returned by {@link LoadMcpCallback}. Kept loose (a plain JSON value) here so
 * the ProxyServer does not depend on the orchestrator's `LoadMcpResult` type — the
 * server just serializes whatever the orchestrator returns into the tool response.
 */
export type LoadMcpCallback = (mcpName: string) => Promise<unknown>;

export type LogMessageParams = LoggingMessageNotification["params"];

type ProxyServerConfig = {
  /**
   * Function returning the current tool catalog. A function (rather than a static value)
   * lets the proxy regenerate `discover_tool`'s description on the fly when an upstream
   * emits `notifications/tools/list_changed`.
   */
  catalog: () => ToolCatalog;
  callTool: ToolCaller;
  /**
   * Aggregated capabilities to advertise to the host during `initialize`. Built by
   * `aggregateCapabilities()` from the union of all upstream capabilities. The proxy
   * always advertises `tools` regardless of upstream support.
   */
  capabilities: ServerCapabilities;
  /**
   * Resource access callbacks. Required when `capabilities.resources` is advertised;
   * otherwise the resource request handlers are not registered.
   */
  resources?: ResourceCallbacks;
  /**
   * Prompt access callbacks. Required when `capabilities.prompts` is advertised;
   * otherwise the prompt request handlers are not registered.
   */
  prompts?: PromptCallbacks;
  /**
   * Completion routing callback. Required when `capabilities.completions` is advertised;
   * otherwise the completion request handler is not registered.
   */
  complete?: CompletionCallback;
  /**
   * Logging set-level callback. Required when `capabilities.logging` is advertised;
   * otherwise the `logging/setLevel` request handler is not registered.
   */
  setLoggingLevel?: LoggingSetLevelCallback;
  /**
   * Invoked when the host emits `notifications/roots/list_changed`. The proxy will
   * call this so the orchestrator can broadcast the change to all upstreams that
   * declared the `roots` client capability to us.
   */
  onRootsListChanged?: () => void | Promise<void>;
  /**
   * Optional dynamic-discovery callback. When provided, the `load_mcp` meta-tool is
   * registered alongside `discover_tool` and `use_tool`. Absent in single-MCP mode
   * and in config-file mode with no `description` fields. See SPEC.md § "Dynamic
   * Discovery" and § "Tools > load_mcp".
   */
  loadMcp?: LoadMcpCallback;
};

const DISCOVER_TOOL_NAME = "discover_tool";
const USE_TOOL_NAME = "use_tool";
const LOAD_MCP_NAME = "load_mcp";

const USE_TOOL_DESCRIPTION =
  "Use a tool that was previously discovered with the discover_tool tool.";

const LOAD_MCP_DESCRIPTION =
  "Load a previously-deferred MCP server so that its tools, resources, and prompts become available. Pass the server name as shown in the <mcp_servers> block of the discover_tool description. Loading is permanent for the remainder of this session.";

const DISCOVER_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    tool_name: { type: "string" as const },
  },
  required: ["tool_name"],
};

const USE_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    tool_name: { type: "string" as const },
    tool_input: { type: "object" as const, additionalProperties: true, default: {} },
  },
  required: ["tool_name"],
};

const LOAD_MCP_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    mcp_name: { type: "string" as const },
  },
  required: ["mcp_name"],
};

const DiscoverToolArgsSchema = z.object({ tool_name: z.string() });
const UseToolArgsSchema = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).default({}),
});
const LoadMcpArgsSchema = z.object({ mcp_name: z.string() });

export class ProxyServer {
  private readonly catalog: () => ToolCatalog;
  private readonly callTool: ToolCaller;
  private readonly capabilities: ServerCapabilities;
  private readonly resources: ResourceCallbacks | undefined;
  private readonly prompts: PromptCallbacks | undefined;
  private readonly complete: CompletionCallback | undefined;
  private readonly setLoggingLevelCallback: LoggingSetLevelCallback | undefined;
  private readonly onRootsListChangedCallback: (() => void | Promise<void>) | undefined;
  private readonly loadMcpCallback: LoadMcpCallback | undefined;
  private sdkServer: Server | null = null;

  constructor({
    catalog,
    callTool,
    capabilities,
    resources,
    prompts,
    complete,
    setLoggingLevel,
    onRootsListChanged,
    loadMcp,
  }: ProxyServerConfig) {
    this.catalog = catalog;
    this.callTool = callTool;
    this.capabilities = capabilities;
    this.resources = resources;
    this.prompts = prompts;
    this.complete = complete;
    this.setLoggingLevelCallback = setLoggingLevel;
    this.onRootsListChangedCallback = onRootsListChanged;
    this.loadMcpCallback = loadMcp;
  }

  buildServer(): Server {
    const server = new Server(
      {
        name: "dynamic-discovery-mcp",
        version: packageJson.version,
      },
      {
        capabilities: this.capabilities,
      },
    );

    this.registerToolHandlers(server);
    if (this.capabilities.resources !== undefined && this.resources !== undefined) {
      this.registerResourceHandlers(server, this.resources);
    }
    if (this.capabilities.prompts !== undefined && this.prompts !== undefined) {
      this.registerPromptHandlers(server, this.prompts);
    }
    if (this.capabilities.completions !== undefined && this.complete !== undefined) {
      this.registerCompletionHandler(server, this.complete);
    }
    if (this.capabilities.logging !== undefined && this.setLoggingLevelCallback !== undefined) {
      this.registerLoggingHandler(server, this.setLoggingLevelCallback);
    }
    if (this.onRootsListChangedCallback !== undefined) {
      const callback = this.onRootsListChangedCallback;
      server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
        await callback();
      });
    }

    this.sdkServer = server;
    return server;
  }

  /**
   * Forwards an upstream-initiated `sampling/createMessage` request to the host. The
   * upstream's abort signal is threaded through so cancellation by the upstream
   * propagates to the host.
   */
  async forwardCreateMessage(
    params: CreateMessageRequest["params"],
    options: { signal: AbortSignal },
  ): Promise<CreateMessageResult> {
    const server = this.requireSdkServer();
    return server.createMessage(params, options);
  }

  /**
   * Forwards an upstream-initiated `elicitation/create` request to the host.
   */
  async forwardElicitInput(
    params: ElicitRequest["params"],
    options: { signal: AbortSignal },
  ): Promise<ElicitResult> {
    const server = this.requireSdkServer();
    return server.elicitInput(params, options);
  }

  /**
   * Forwards an upstream-initiated `roots/list` request to the host.
   */
  async forwardListRoots(
    params: ListRootsRequest["params"],
    options: { signal: AbortSignal },
  ): Promise<ListRootsResult> {
    const server = this.requireSdkServer();
    return server.listRoots(params, options);
  }

  private requireSdkServer(): Server {
    if (this.sdkServer === null) {
      throw new Error("ProxyServer is not built. Call buildServer() before forwarding requests.");
    }
    return this.sdkServer;
  }

  async start(): Promise<void> {
    const server = this.buildServer();
    const transport = new StdioServerTransport();
    process.stderr.write("Starting dynamic-discovery-mcp server over stdio\n");
    await server.connect(transport);
  }

  /**
   * Notifies the host that the discover_tool description has changed because an upstream
   * emitted `notifications/tools/list_changed`. The host should re-fetch the tools list
   * to pick up the regenerated catalog. Silently no-ops if `buildServer()` has not been
   * called yet.
   */
  async sendToolListChanged(): Promise<void> {
    if (this.sdkServer !== null) {
      await this.sdkServer.sendToolListChanged();
    }
  }

  /**
   * Notifies the host that the proxy's aggregated resource list has changed. Silently
   * no-ops if `buildServer()` has not been called yet. Errors propagate.
   */
  async sendResourceListChanged(): Promise<void> {
    if (this.sdkServer !== null) {
      await this.sdkServer.sendResourceListChanged();
    }
  }

  /**
   * Notifies the host that a specific subscribed resource has changed. Silently no-ops
   * if `buildServer()` has not been called yet.
   */
  async sendResourceUpdated(params: { uri: string }): Promise<void> {
    if (this.sdkServer !== null) {
      await this.sdkServer.sendResourceUpdated(params);
    }
  }

  /**
   * Notifies the host that the proxy's aggregated prompt list has changed. Silently
   * no-ops if `buildServer()` has not been called yet.
   */
  async sendPromptListChanged(): Promise<void> {
    if (this.sdkServer !== null) {
      await this.sdkServer.sendPromptListChanged();
    }
  }

  /**
   * Builds per-call options for a request handler. Extracts the host's
   * `progressToken` from `_meta` (if any) and wires an `onprogress` callback that
   * re-emits progress notifications back to the host under that same token. This
   * is the single seam where progress translation lives — every forward-direction
   * handler routes through here.
   */
  private buildCallOptions(
    request: { params: { _meta?: { progressToken?: string | number } } },
    extra: {
      signal: AbortSignal;
      sendNotification: (notification: {
        method: string;
        params?: Record<string, unknown>;
      }) => Promise<void>;
    },
  ): ProxyCallOptions {
    const options: ProxyCallOptions = { signal: extra.signal };
    const progressToken = request.params._meta?.progressToken;
    if (progressToken !== undefined) {
      options.onprogress = progress => {
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: progress.progress,
            total: progress.total,
            message: progress.message,
          },
        });
      };
    }
    return options;
  }

  private registerToolHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      type ListedTool = {
        name: string;
        description: string;
        inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
      };
      const tools: ListedTool[] = [
        {
          name: DISCOVER_TOOL_NAME,
          description: this.catalog().discoverToolDescription,
          inputSchema: DISCOVER_TOOL_INPUT_SCHEMA,
        },
        {
          name: USE_TOOL_NAME,
          description: USE_TOOL_DESCRIPTION,
          inputSchema: USE_TOOL_INPUT_SCHEMA,
        },
      ];
      if (this.loadMcpCallback !== undefined) {
        tools.push({
          name: LOAD_MCP_NAME,
          description: LOAD_MCP_DESCRIPTION,
          inputSchema: LOAD_MCP_INPUT_SCHEMA,
        });
      }
      return { tools };
    });

    server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        const { name, arguments: rawArgs } = request.params;
        const catalog = this.catalog();

        if (name === DISCOVER_TOOL_NAME) {
          const args = DiscoverToolArgsSchema.parse(rawArgs ?? {});
          return {
            content: [{ type: "text", text: catalog.getToolDetails(args.tool_name) }],
          };
        }

        if (name === USE_TOOL_NAME) {
          const args = UseToolArgsSchema.parse(rawArgs ?? {});
          if (!catalog.tools.has(args.tool_name)) {
            return {
              content: [{ type: "text", text: catalog.getToolDetails(args.tool_name) }],
            };
          }
          return await this.callTool(
            args.tool_name,
            args.tool_input,
            this.buildCallOptions(request, extra),
          );
        }

        if (name === LOAD_MCP_NAME && this.loadMcpCallback !== undefined) {
          const args = LoadMcpArgsSchema.parse(rawArgs ?? {});
          try {
            const result = await this.loadMcpCallback(args.mcp_name);
            return {
              // The structured payload is JSON-serialized into a text block. We also
              // populate `structuredContent` so MCP clients that prefer typed data can
              // consume the same response without parsing the text body.
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: result as Record<string, unknown>,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              isError: true,
              content: [{ type: "text", text: message }],
            };
          }
        }

        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: "${name}"` }],
        };
      },
    );
  }

  private registerResourceHandlers(server: Server, callbacks: ResourceCallbacks): void {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      async (): Promise<ListResourcesResult> => ({
        resources: callbacks.listResources(),
      }),
    );

    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (): Promise<ListResourceTemplatesResult> => ({
        resourceTemplates: callbacks.listResourceTemplates(),
      }),
    );

    server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, extra): Promise<ReadResourceResult> => {
        return callbacks.readResource(request.params.uri, this.buildCallOptions(request, extra));
      },
    );

    server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
      await callbacks.subscribeResource(request.params.uri, this.buildCallOptions(request, extra));
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
      await callbacks.unsubscribeResource(
        request.params.uri,
        this.buildCallOptions(request, extra),
      );
      return {};
    });
  }

  private registerPromptHandlers(server: Server, callbacks: PromptCallbacks): void {
    server.setRequestHandler(
      ListPromptsRequestSchema,
      async (): Promise<ListPromptsResult> => ({
        prompts: callbacks.listPrompts(),
      }),
    );

    server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, extra): Promise<GetPromptResult> => {
        return callbacks.getPrompt(
          request.params.name,
          request.params.arguments,
          this.buildCallOptions(request, extra),
        );
      },
    );
  }

  private registerCompletionHandler(server: Server, callback: CompletionCallback): void {
    server.setRequestHandler(
      CompleteRequestSchema,
      async (request, extra): Promise<CompleteResult> => {
        return callback(request.params, this.buildCallOptions(request, extra));
      },
    );
  }

  private registerLoggingHandler(server: Server, callback: LoggingSetLevelCallback): void {
    server.setRequestHandler(SetLevelRequestSchema, async (request, extra) => {
      await callback(request.params.level, this.buildCallOptions(request, extra));
      return {};
    });
  }

  /**
   * Forwards a log message from an upstream MCP to the host. Silently no-ops if
   * `buildServer()` has not been called yet.
   */
  async sendLoggingMessage(params: LogMessageParams): Promise<void> {
    if (this.sdkServer !== null) {
      await this.sdkServer.sendLoggingMessage(params);
    }
  }
}
