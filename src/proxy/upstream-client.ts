import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ContentResult } from "fastmcp";

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

type UpstreamClientConfig = {
  name: string;
  transport: Transport;
  onTransportError?: (error: Error) => void;
};

export class UpstreamClient {
  private readonly transport: Transport;
  private readonly onTransportError: (error: Error) => void;
  private client: Client | null = null;

  constructor({ name, transport, onTransportError }: UpstreamClientConfig) {
    this.transport = transport;
    this.onTransportError =
      onTransportError ??
      ((error: Error) => {
        process.stderr.write(`[${name}] Upstream MCP transport error: ${error.message}\n`);
      });
  }

  async connect(): Promise<void> {
    this.transport.onerror = this.onTransportError;
    this.client = new Client({ name: "dynamic-discovery-mcp", version: "1.0.0" });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<UpstreamTool[]> {
    if (this.client === null) {
      throw new Error("Client is not connected. Call connect() first.");
    }

    const result = await this.client.listTools();

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

  async callTool(name: string, input: Record<string, unknown>): Promise<ContentResult> {
    if (this.client === null) {
      throw new Error("Client is not connected. Call connect() first.");
    }

    const result = await this.client.callTool({ name, arguments: input });
    return result as ContentResult;
  }

  async disconnect(): Promise<void> {
    if (this.client === null) {
      return;
    }

    await this.client.close();
    this.client = null;
  }
}
