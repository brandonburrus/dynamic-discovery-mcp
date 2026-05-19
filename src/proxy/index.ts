import process from "node:process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadConfig } from "../config/index.js";
import { Orchestrator } from "./orchestrator.js";
import { ProxyServer } from "./server.js";
import { createTransport } from "./transport-factory.js";

const SINGLE_MCP_NAME = "__default__";

export async function startProxy(command: string, args: string[]): Promise<void> {
  const transport = new StdioClientTransport({ command, args });
  const mcps = new Map<string, { transport: Transport }>([[SINGLE_MCP_NAME, { transport }]]);

  const orchestrator = buildOrchestrator({
    mcps,
    namespaced: false,
    transportErrorPrefix: () => "Upstream MCP",
  });

  await runProxy(orchestrator);
}

export interface StartProxyFromConfigOptions {
  configPath?: string;
  envFilePath?: string;
}

export async function startProxyFromConfig(
  options: StartProxyFromConfigOptions = {},
): Promise<void> {
  const config = loadConfig(options);

  const mcps = new Map<string, { transport: Transport }>();
  for (const [name, entry] of Object.entries(config.mcp)) {
    mcps.set(name, { transport: createTransport(entry) });
  }

  const orchestrator = buildOrchestrator({
    mcps,
    namespaced: true,
    transportErrorPrefix: mcpName => `Upstream MCP "${mcpName}"`,
  });

  await runProxy(orchestrator);
}

type BuildOrchestratorParams = {
  mcps: Map<string, { transport: Transport }>;
  namespaced: boolean;
  transportErrorPrefix: (mcpName: string) => string;
};

// Forward declaration so buildOrchestrator can reference the shutdown closure constructed
// inside runProxy. Each invocation of runProxy installs its own shutdown function on this
// holder before the orchestrator's transport-error callbacks can fire.
type ShutdownHolder = { shutdown: ((code: number) => void) | null };

const activeShutdown: ShutdownHolder = { shutdown: null };

function buildOrchestrator(params: BuildOrchestratorParams): Orchestrator {
  return new Orchestrator({
    mcps: params.mcps,
    namespaced: params.namespaced,
    onTransportError: (mcpName: string, error: Error) => {
      process.stderr.write(
        `${params.transportErrorPrefix(mcpName)} transport error: ${error.message}\n`,
      );
      activeShutdown.shutdown?.(1);
    },
  });
}

async function runProxy(orchestrator: Orchestrator): Promise<void> {
  let isShuttingDown = false;

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

  activeShutdown.shutdown = shutdown;

  try {
    await orchestrator.connect();
  } catch (error) {
    process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }

  const proxyServer = new ProxyServer({
    catalog: () => orchestrator.catalog,
    capabilities: orchestrator.capabilities,
    callTool: (name, input, options) => orchestrator.callTool(name, input, options),
    resources:
      orchestrator.capabilities.resources !== undefined
        ? {
            listResources: () => orchestrator.listResources(),
            listResourceTemplates: () => orchestrator.listResourceTemplates(),
            readResource: (uri, options) => orchestrator.readResource(uri, options),
            subscribeResource: (uri, options) => orchestrator.subscribeResource(uri, options),
            unsubscribeResource: (uri, options) => orchestrator.unsubscribeResource(uri, options),
          }
        : undefined,
    prompts:
      orchestrator.capabilities.prompts !== undefined
        ? {
            listPrompts: () => orchestrator.listPrompts(),
            getPrompt: (name, args, options) => orchestrator.getPrompt(name, args, options),
          }
        : undefined,
    complete:
      orchestrator.capabilities.completions !== undefined
        ? (params, options) => orchestrator.complete(params, options)
        : undefined,
    setLoggingLevel:
      orchestrator.capabilities.logging !== undefined
        ? (level, options) => orchestrator.setLoggingLevel(level, options)
        : undefined,
    onRootsListChanged: () => orchestrator.broadcastRootsListChanged(),
  });

  orchestrator.setNotificationHandlers({
    onToolsListChanged: () => proxyServer.sendToolListChanged(),
    onResourcesListChanged: () => proxyServer.sendResourceListChanged(),
    onResourceUpdated: params => proxyServer.sendResourceUpdated(params),
    onPromptsListChanged: () => proxyServer.sendPromptListChanged(),
    onLogMessage: params => proxyServer.sendLoggingMessage(params),
  });

  orchestrator.setServerRequestForwarders({
    onCreateMessage: (params, options) => proxyServer.forwardCreateMessage(params, options),
    onElicitInput: (params, options) => proxyServer.forwardElicitInput(params, options),
    onListRoots: (params, options) => proxyServer.forwardListRoots(params, options),
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
