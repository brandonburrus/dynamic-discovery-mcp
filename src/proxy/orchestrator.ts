import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ContentResult } from "fastmcp";
import { ToolCatalog } from "./tool-catalog.js";
import { UpstreamClient } from "./upstream-client.js";

export type OrchestratorConfig = {
  mcps: Map<string, { transport: Transport }>;
  onTransportError?: (mcpName: string, error: Error) => void;
};

export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly clients: Map<string, UpstreamClient> = new Map();
  private toolCatalog: ToolCatalog | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const groups = new Map<string, import("./upstream-client.js").UpstreamTool[]>();

    try {
      for (const [mcpName, { transport }] of this.config.mcps) {
        const client = new UpstreamClient({
          name: mcpName,
          transport,
          onTransportError: (error: Error) => {
            this.config.onTransportError?.(mcpName, error);
          },
        });

        await client.connect();
        const tools = await client.listTools();

        this.clients.set(mcpName, client);
        groups.set(mcpName, tools);
      }
    } catch (error) {
      await this.disconnectAll();
      throw error;
    }

    this.toolCatalog = ToolCatalog.fromGrouped(groups);
  }

  get catalog(): ToolCatalog {
    if (this.toolCatalog === null) {
      throw new Error("Orchestrator is not connected. Call connect() first.");
    }
    return this.toolCatalog;
  }

  async callTool(namespacedName: string, input: Record<string, unknown>): Promise<ContentResult> {
    const separatorIndex = namespacedName.indexOf("/");
    if (separatorIndex === -1) {
      throw new Error(
        `Invalid namespaced tool name: "${namespacedName}". Expected format: "mcpName/toolName".`,
      );
    }

    const mcpName = namespacedName.slice(0, separatorIndex);
    const toolName = namespacedName.slice(separatorIndex + 1);

    const client = this.clients.get(mcpName);
    if (client === undefined) {
      const available = [...this.clients.keys()].sort().join(", ");
      throw new Error(`Unknown MCP: "${mcpName}". Available MCPs: ${available}`);
    }

    return client.callTool(toolName, input);
  }

  async disconnectAll(): Promise<void> {
    const disconnections = [...this.clients.values()].map(client => client.disconnect());
    await Promise.all(disconnections);
    this.clients.clear();
    this.toolCatalog = null;
  }
}
