import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface StdioTransportConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Tolerated but unused by the factory. Present so a Zod-validated config entry can be
  // forwarded here without an intermediate destructure; the field is consumed by the
  // orchestrator's lazy-loading logic, not by transport construction.
  description?: string;
}

interface StreamableHttpTransportConfig {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  description?: string;
}

interface SseTransportConfig {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  description?: string;
}

export type McpTransportConfig =
  | StdioTransportConfig
  | StreamableHttpTransportConfig
  | SseTransportConfig;

export function createTransport(config: McpTransportConfig): Transport {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined,
      );

    case "sse":
      return new SSEClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined,
      );

    default: {
      const _exhaustive: never = config;
      return _exhaustive;
    }
  }
}
