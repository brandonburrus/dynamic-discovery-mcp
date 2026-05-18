import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  command: string;
  args: string[];
  onTransportError?: (error: Error) => void;
};

export class UpstreamClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly onTransportError: (error: Error) => void;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor({ command, args, onTransportError }: UpstreamClientConfig) {
    this.command = command;
    this.args = args;
    this.onTransportError =
      onTransportError ??
      ((error: Error) => {
        process.stderr.write(`Upstream MCP transport error: ${error.message}\n`);
      });
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
    });

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

    return this.client.callTool({
      name,
      arguments: input,
    }) as Promise<ContentResult>;
  }

  async disconnect(): Promise<void> {
    if (this.client === null) {
      return;
    }

    await this.client.close();
    this.client = null;
    this.transport = null;
  }
}
