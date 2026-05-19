import process from "node:process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../config/index.js";
import { createTransport } from "./transport-factory.js";
import { Orchestrator } from "./orchestrator.js";
import { ToolCatalog } from "./tool-catalog.js";
import { ProxyServer } from "./server.js";
import { UpstreamClient } from "./upstream-client.js";

export async function startProxy(command: string, args: string[]): Promise<void> {
  let isShuttingDown = false;

  const transport = new StdioClientTransport({ command, args });

  const upstreamClient = new UpstreamClient({
    name: command,
    transport,
    onTransportError: (error: Error) => {
      process.stderr.write(`Upstream MCP transport error: ${error.message}\n`);
      shutdown(1);
    },
  });

  const shutdown = (exitCode: number): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    upstreamClient
      .disconnect()
      .catch((error: unknown) => {
        process.stderr.write(
          `dynmcp: error during disconnect: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => process.exit(exitCode));
  };

  try {
    await upstreamClient.connect();
  } catch (error) {
    process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  let tools: Awaited<ReturnType<UpstreamClient["listTools"]>>;
  try {
    tools = await upstreamClient.listTools();
  } catch (error) {
    process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const catalog = ToolCatalog.fromFlat(tools);
  const proxyServer = new ProxyServer({
    catalog,
    callTool: (name, input) => upstreamClient.callTool(name, input),
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));

  try {
    await proxyServer.start();
  } catch (error) {
    shutdown(1);
    throw error;
  }
}

export interface StartProxyFromConfigOptions {
  configPath?: string;
  envFilePath?: string;
}

export async function startProxyFromConfig(
  options: StartProxyFromConfigOptions = {},
): Promise<void> {
  let isShuttingDown = false;

  const config = loadConfig(options);

  const mcps = new Map<string, { transport: ReturnType<typeof createTransport> }>();
  for (const [name, entry] of Object.entries(config.mcp)) {
    mcps.set(name, { transport: createTransport(entry) });
  }

  const orchestrator = new Orchestrator({
    mcps,
    onTransportError: (mcpName: string, error: Error) => {
      process.stderr.write(`Upstream MCP "${mcpName}" transport error: ${error.message}\n`);
      shutdown(1);
    },
  });

  const shutdown = (exitCode: number): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    orchestrator
      .disconnectAll()
      .catch((error: unknown) => {
        process.stderr.write(
          `dynmcp: error during disconnect: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => process.exit(exitCode));
  };

  try {
    await orchestrator.connect();
  } catch (error) {
    process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const proxyServer = new ProxyServer({
    catalog: orchestrator.catalog,
    callTool: (name, input) => orchestrator.callTool(name, input),
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));

  try {
    await proxyServer.start();
  } catch (error) {
    shutdown(1);
    throw error;
  }
}
