import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  type CompleteRequest,
  type CompleteResult,
  type CreateMessageRequest,
  type CreateMessageResult,
  CreateMessageRequestSchema,
  type ElicitRequest,
  type ElicitResult,
  ElicitRequestSchema,
  type GetPromptResult,
  type ListRootsRequest,
  type ListRootsResult,
  ListRootsRequestSchema,
  type LoggingLevel,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Prompt,
  PromptListChangedNotificationSchema,
  type ReadResourceResult,
  type Resource,
  ResourceListChangedNotificationSchema,
  type ResourceTemplate,
  ResourceUpdatedNotificationSchema,
  type ServerCapabilities,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type LogMessageParams = LoggingMessageNotification["params"];

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type UpstreamTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
};

export type UpstreamNotificationHandlers = {
  onToolsListChanged?: () => void | Promise<void>;
  onResourcesListChanged?: () => void | Promise<void>;
  onResourceUpdated?: (params: { uri: string }) => void | Promise<void>;
  onPromptsListChanged?: () => void | Promise<void>;
  onLogMessage?: (params: LogMessageParams) => void | Promise<void>;
};

/**
 * Per-call options forwarded to the SDK so cancellation can propagate from the host
 * down to the upstream MCP. When the host cancels its incoming request, the SDK
 * server handler's `signal` aborts; passing that signal through these options causes
 * the SDK client to emit `notifications/cancelled` to the upstream.
 */
export type UpstreamCallOptions = {
  signal?: AbortSignal;
};

/**
 * Reverse-direction handlers invoked when an upstream MCP sends a server-initiated
 * request to the proxy (e.g. `sampling/createMessage`). The proxy forwards each
 * request to the host via these callbacks; the host's response is returned to the
 * originating upstream by the SDK.
 *
 * The `signal` parameter is the upstream's request abort signal — passing it through
 * to the host call causes the host's request to be cancelled if the upstream cancels.
 */
export type UpstreamServerRequestHandlers = {
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

type UpstreamClientConfig = {
  name: string;
  transport: Transport;
  onTransportError?: (error: Error) => void;
  notifications?: UpstreamNotificationHandlers;
  serverRequests?: UpstreamServerRequestHandlers;
};

export class UpstreamClient {
  private readonly transport: Transport;
  private readonly onTransportError: (error: Error) => void;
  private readonly notificationHandlers: UpstreamNotificationHandlers;
  private readonly serverRequestHandlers: UpstreamServerRequestHandlers;
  private client: Client | null = null;

  constructor({
    name,
    transport,
    onTransportError,
    notifications,
    serverRequests,
  }: UpstreamClientConfig) {
    this.transport = transport;
    this.notificationHandlers = notifications ?? {};
    this.serverRequestHandlers = serverRequests ?? {};
    this.onTransportError =
      onTransportError ??
      ((error: Error) => {
        process.stderr.write(`[${name}] Upstream MCP transport error: ${error.message}\n`);
      });
  }

  async connect(): Promise<void> {
    this.transport.onerror = this.onTransportError;
    this.client = new Client(
      { name: "dynamic-discovery-mcp", version: "1.0.0" },
      {
        capabilities: {
          // Declare every client-side capability the proxy may relay on behalf of the host.
          // Actual reachability of each feature depends on what the host supports — if the
          // host does not support sampling, for instance, the host call returns an error
          // which we forward back to the upstream verbatim.
          sampling: {},
          elicitation: {},
          roots: { listChanged: true },
        },
      },
    );

    this.registerServerRequestHandlers(this.client);

    if (this.notificationHandlers.onToolsListChanged !== undefined) {
      this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this.notificationHandlers.onToolsListChanged?.();
      });
    }
    if (this.notificationHandlers.onResourcesListChanged !== undefined) {
      this.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        await this.notificationHandlers.onResourcesListChanged?.();
      });
    }
    if (this.notificationHandlers.onResourceUpdated !== undefined) {
      this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, async notification => {
        await this.notificationHandlers.onResourceUpdated?.({ uri: notification.params.uri });
      });
    }
    if (this.notificationHandlers.onPromptsListChanged !== undefined) {
      this.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        await this.notificationHandlers.onPromptsListChanged?.();
      });
    }
    if (this.notificationHandlers.onLogMessage !== undefined) {
      this.client.setNotificationHandler(LoggingMessageNotificationSchema, async notification => {
        await this.notificationHandlers.onLogMessage?.(notification.params);
      });
    }

    await this.client.connect(this.transport);
  }

  async setLoggingLevel(level: LoggingLevel, options?: UpstreamCallOptions): Promise<void> {
    const client = this.requireClient();
    await client.setLoggingLevel(level, options);
  }

  async listPrompts(options?: UpstreamCallOptions): Promise<Prompt[]> {
    const client = this.requireClient();
    const result = await client.listPrompts(undefined, options);
    return result.prompts;
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    options?: UpstreamCallOptions,
  ): Promise<GetPromptResult> {
    const client = this.requireClient();
    const params: { name: string; arguments?: Record<string, string> } = { name };
    if (args !== undefined) {
      params.arguments = args;
    }
    return client.getPrompt(params, options);
  }

  async complete(
    params: CompleteRequest["params"],
    options?: UpstreamCallOptions,
  ): Promise<CompleteResult> {
    const client = this.requireClient();
    return client.complete(params, options);
  }

  /**
   * Returns the capabilities advertised by the upstream server during initialize.
   * Returns `undefined` if the client is not connected, or if the SDK has not yet
   * recorded the server's capabilities (e.g. during a partially-completed handshake).
   */
  getCapabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
  }

  async listTools(options?: UpstreamCallOptions): Promise<UpstreamTool[]> {
    const client = this.requireClient();
    const result = await client.listTools(undefined, options);

    return result.tools.map(tool => {
      const upstreamTool: UpstreamTool = {
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      };

      if (tool.outputSchema !== undefined) {
        upstreamTool.outputSchema = tool.outputSchema;
      }

      if (tool.annotations !== undefined) {
        upstreamTool.annotations = {
          title: tool.annotations.title,
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        };
      }

      return upstreamTool;
    });
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    options?: UpstreamCallOptions,
  ): Promise<CallToolResult> {
    const client = this.requireClient();
    const result = await client.callTool({ name, arguments: input }, undefined, options);
    return result as CallToolResult;
  }

  async listResources(options?: UpstreamCallOptions): Promise<Resource[]> {
    const client = this.requireClient();
    const result = await client.listResources(undefined, options);
    return result.resources;
  }

  async listResourceTemplates(options?: UpstreamCallOptions): Promise<ResourceTemplate[]> {
    const client = this.requireClient();
    const result = await client.listResourceTemplates(undefined, options);
    return result.resourceTemplates;
  }

  async readResource(uri: string, options?: UpstreamCallOptions): Promise<ReadResourceResult> {
    const client = this.requireClient();
    return client.readResource({ uri }, options);
  }

  async subscribeResource(uri: string, options?: UpstreamCallOptions): Promise<void> {
    const client = this.requireClient();
    await client.subscribeResource({ uri }, options);
  }

  async unsubscribeResource(uri: string, options?: UpstreamCallOptions): Promise<void> {
    const client = this.requireClient();
    await client.unsubscribeResource({ uri }, options);
  }

  async disconnect(): Promise<void> {
    if (this.client === null) {
      return;
    }

    await this.client.close();
    this.client = null;
  }

  /**
   * Sends `notifications/roots/list_changed` to the upstream, letting it know that
   * the host's set of filesystem roots has changed.
   */
  async sendRootsListChanged(): Promise<void> {
    const client = this.requireClient();
    await client.sendRootsListChanged();
  }

  private registerServerRequestHandlers(client: Client): void {
    if (this.serverRequestHandlers.onCreateMessage !== undefined) {
      client.setRequestHandler(
        CreateMessageRequestSchema,
        async (request, extra): Promise<CreateMessageResult> => {
          return this.serverRequestHandlers.onCreateMessage!(request.params, {
            signal: extra.signal,
          });
        },
      );
    }
    if (this.serverRequestHandlers.onElicitInput !== undefined) {
      client.setRequestHandler(
        ElicitRequestSchema,
        async (request, extra): Promise<ElicitResult> => {
          return this.serverRequestHandlers.onElicitInput!(request.params, {
            signal: extra.signal,
          });
        },
      );
    }
    if (this.serverRequestHandlers.onListRoots !== undefined) {
      client.setRequestHandler(
        ListRootsRequestSchema,
        async (request, extra): Promise<ListRootsResult> => {
          return this.serverRequestHandlers.onListRoots!(request.params, {
            signal: extra.signal,
          });
        },
      );
    }
  }

  private requireClient(): Client {
    if (this.client === null) {
      throw new Error("Client is not connected. Call connect() first.");
    }
    return this.client;
  }
}
