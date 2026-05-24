import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { KeychainStore, ProxyOAuthProvider, type ConfigAuthOverrides } from "../auth/index.js";

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
  /**
   * Optional pre-registered OAuth client credentials. When omitted, the proxy uses
   * Dynamic Client Registration during `dynmcp login` instead. Either way, the
   * proxy's runtime auth provider is constructed automatically — config values for
   * this field flow through to {@link ProxyOAuthProvider}, the runtime side of the
   * auth machinery, where they take precedence over cached DCR results.
   */
  auth?: ConfigAuthOverrides;
}

interface SseTransportConfig {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  description?: string;
  auth?: ConfigAuthOverrides;
}

export type McpTransportConfig =
  | StdioTransportConfig
  | StreamableHttpTransportConfig
  | SseTransportConfig;

/**
 * Builds the SDK transport object for a single upstream MCP entry. For HTTP-based
 * transports the factory also constructs a {@link ProxyOAuthProvider} and wires it
 * into the transport, so OAuth-protected upstreams transparently use cached tokens
 * from the keychain and silently refresh as needed. See SPEC.md § "Upstream OAuth >
 * Proxy Runtime Behavior".
 *
 * The provider is constructed unconditionally for HTTP / SSE transports. When the
 * upstream does not require OAuth at all, the provider's empty token state means the
 * SDK simply doesn't attach an `Authorization` header — the provider is inert. When
 * the upstream does require OAuth and no credentials are cached, the provider
 * throws {@link AuthRequiredError} with the actionable "run dynmcp login" message.
 *
 * @param mcpName the configured MCP name; used for keychain entry naming and error
 *   messages. Pass an empty string in tests that don't exercise auth.
 * @param config the validated transport config for one upstream
 */
export function createTransport(mcpName: string, config: McpTransportConfig): Transport {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

    case "streamable-http":
      return new StreamableHTTPClientTransport(new URL(config.url), {
        ...(config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}),
        authProvider: buildOAuthProvider(mcpName, config),
      });

    case "sse":
      return new SSEClientTransport(new URL(config.url), {
        ...(config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}),
        authProvider: buildOAuthProvider(mcpName, config),
      });

    default: {
      const _exhaustive: never = config;
      return _exhaustive;
    }
  }
}

function buildOAuthProvider(
  mcpName: string,
  config: StreamableHttpTransportConfig | SseTransportConfig,
): ProxyOAuthProvider {
  const keychain = new KeychainStore(mcpName, config.url);
  return new ProxyOAuthProvider(mcpName, keychain, config.auth);
}
