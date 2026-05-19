import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  UpstreamClient,
  type UpstreamNotificationHandlers,
  type UpstreamServerRequestHandlers,
} from "./upstream-client.js";

/**
 * Per-upstream configuration handed to {@link UpstreamRegistry.connectAll}. The registry
 * is intentionally oblivious to what the notification and server-request handlers do —
 * the caller (typically the Orchestrator) owns that logic and supplies pre-built
 * handlers that close over its own state.
 */
export type UpstreamConfig = {
  transport: Transport;
  onTransportError?: (error: Error) => void;
  notifications?: UpstreamNotificationHandlers;
  serverRequests?: UpstreamServerRequestHandlers;
};

/**
 * Owns the lifecycle of every connected upstream MCP. Responsibilities are narrow:
 * spin clients up, expose them by name (or as the unique sole client in single-MCP
 * mode), and tear them all down on shutdown. Catalog building, routing, notification
 * translation, and capability aggregation are deliberately not in scope here — the
 * Orchestrator composes those concerns around this registry.
 *
 * Connection is all-or-nothing: if any client fails to connect during
 * {@link connectAll}, every already-connected client is disconnected before the
 * original error is re-thrown.
 */
export class UpstreamRegistry {
  private readonly clients: Map<string, UpstreamClient> = new Map();

  async connectAll(entries: ReadonlyArray<readonly [string, UpstreamConfig]>): Promise<void> {
    try {
      for (const [mcpName, config] of entries) {
        const client = new UpstreamClient({
          name: mcpName,
          transport: config.transport,
          onTransportError: config.onTransportError,
          notifications: config.notifications,
          serverRequests: config.serverRequests,
        });
        await client.connect();
        this.clients.set(mcpName, client);
      }
    } catch (error) {
      await this.disconnectAll();
      throw error;
    }
  }

  get(mcpName: string): UpstreamClient | undefined {
    return this.clients.get(mcpName);
  }

  /**
   * Returns the sole connected client. Used by single-MCP (`--`) mode where the
   * Orchestrator guarantees there is exactly one upstream. Returns undefined when
   * zero or more than one client is connected.
   */
  sole(): UpstreamClient | undefined {
    if (this.clients.size !== 1) return undefined;
    return this.clients.values().next().value;
  }

  names(): readonly string[] {
    return [...this.clients.keys()];
  }

  entries(): IterableIterator<[string, UpstreamClient]> {
    return this.clients.entries();
  }

  size(): number {
    return this.clients.size;
  }

  async disconnectAll(): Promise<void> {
    const disconnections = [...this.clients.values()].map(client => client.disconnect());
    await Promise.all(disconnections);
    this.clients.clear();
  }
}
