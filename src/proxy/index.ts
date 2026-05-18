import process from "node:process";
import { ToolCatalog } from "./tool-catalog.js";
import { ProxyServer } from "./server.js";
import { UpstreamClient } from "./upstream-client.js";

export async function startProxy(command: string, args: string[]): Promise<void> {
  let isShuttingDown = false;

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

  const upstreamClient = new UpstreamClient({
    command,
    args,
    onTransportError: (error: Error) => {
      process.stderr.write(`Upstream MCP transport error: ${error.message}\n`);
      shutdown(1);
    },
  });

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

  const catalog = new ToolCatalog(tools);
  const proxyServer = new ProxyServer({ catalog, upstreamClient });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));

  await proxyServer.start();
}
