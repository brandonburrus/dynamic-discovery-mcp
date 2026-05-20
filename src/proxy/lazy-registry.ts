import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * One unconnected lazy upstream MCP. Held by {@link LazyRegistry} until a `load_mcp`
 * call promotes it to a connected upstream in the {@link UpstreamRegistry}.
 *
 * The transport is constructed at startup (so a misconfigured transport surfaces
 * before any host traffic arrives) but is not actually opened until load time —
 * {@link UpstreamClient.connect} is what opens the underlying connection.
 */
export type LazyEntry = {
  readonly description: string;
  readonly transport: Transport;
};

/**
 * Stores the lazy-loading-eligible upstream MCPs declared in the config file —
 * those entries that carry a `description` field. The registry preserves the
 * config-file insertion order so the `<mcp_servers>` block in `discover_tool`'s
 * description renders in a stable order matching the user's config.
 *
 * Once a lazy MCP transitions to `loaded` (via the orchestrator's `loadMcp`
 * pipeline), {@link take} is called to remove it from this registry. There is
 * no "unloaded" state by design — see SPEC.md § "Dynamic Discovery > Lifecycle".
 *
 * Failed loads are tracked per-entry via {@link recordFailure}. After enough
 * consecutive failures the orchestrator will evict the entry — this prevents
 * an agent from burning forever on a broken upstream while still tolerating
 * transient hiccups.
 */
export class LazyRegistry {
  private readonly entries: Map<string, LazyEntry> = new Map();
  private readonly failureCounts: Map<string, number> = new Map();

  register(name: string, entry: LazyEntry): void {
    if (this.entries.has(name)) {
      throw new Error(`LazyRegistry: duplicate registration for "${name}"`);
    }
    this.entries.set(name, entry);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get(name: string): LazyEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Records a failed load attempt and returns the new total. The orchestrator's
   * retry-budget logic uses this to decide whether to evict the entry. A
   * subsequent successful load (or {@link take}) clears the count.
   */
  recordFailure(name: string): number {
    const next = (this.failureCounts.get(name) ?? 0) + 1;
    this.failureCounts.set(name, next);
    return next;
  }

  failureCount(name: string): number {
    return this.failureCounts.get(name) ?? 0;
  }

  /**
   * Returns the descriptions of every still-lazy MCP in insertion order. Consumed
   * by {@link ToolCatalog.fromGroupedWithLazy} to render the `<mcp_servers>` block.
   */
  descriptions(): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const [name, entry] of this.entries) {
      result.set(name, entry.description);
    }
    return result;
  }

  /**
   * Returns the names of every still-lazy MCP in insertion order. Used by error
   * messages that need to hint the agent at what is loadable.
   */
  names(): readonly string[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Removes and returns the entry, signalling that the upstream has been (or is
   * about to be) promoted to a connected client (or evicted after exhausting
   * its retry budget). The caller is responsible for ensuring the promotion
   * actually succeeds — failed loads should re-register via {@link register} to
   * roll back the state. Clears the failure count along with the entry.
   */
  take(name: string): LazyEntry | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    this.entries.delete(name);
    this.failureCounts.delete(name);
    return entry;
  }
}
