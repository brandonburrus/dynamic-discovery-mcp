import process from "node:process";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import type { ContentResult } from "fastmcp";
import type { ToolCatalog } from "./tool-catalog.js";

type ToolCaller = (name: string, input: Record<string, unknown>) => Promise<ContentResult>;

type ProxyServerConfig = {
  catalog: ToolCatalog;
  callTool: ToolCaller;
};

export class ProxyServer {
  private readonly catalog: ToolCatalog;
  private readonly callTool: ToolCaller;

  constructor({ catalog, callTool }: ProxyServerConfig) {
    this.catalog = catalog;
    this.callTool = callTool;
  }

  async start(): Promise<void> {
    const server = new FastMCP({
      name: "dynamic-discovery-mcp",
      version: packageJson.version as `${number}.${number}.${number}`,
    });

    server.addTool({
      name: "discover_tool",
      description: this.catalog.discoverToolDescription,
      parameters: z.object({ tool_name: z.string() }),
      execute: async ({ tool_name }) => {
        return this.catalog.getToolDetails(tool_name);
      },
    });

    server.addTool({
      name: "use_tool",
      description: "Use a tool that was previously discovered with the discover_tool tool.",
      parameters: z.object({
        tool_name: z.string(),
        tool_input: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async ({ tool_name, tool_input }) => {
        if (!this.catalog.tools.has(tool_name)) {
          return this.catalog.getToolDetails(tool_name);
        }

        const result = await this.callTool(tool_name, tool_input);
        return result;
      },
    });

    process.stderr.write("Starting dynamic-discovery-mcp server over stdio\n");
    await server.start({ transportType: "stdio" });
  }
}
