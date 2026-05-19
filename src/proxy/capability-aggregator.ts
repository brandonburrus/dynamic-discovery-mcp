import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Aggregates the capabilities advertised by every upstream MCP into the single
 * capability set that the proxy will advertise to the host during `initialize`.
 *
 * Rules (per SPEC.md "Capability Aggregation"):
 *
 * - `tools` is always advertised — the proxy itself exposes `discover_tool` and `use_tool`
 *   regardless of upstream support.
 * - `tools.listChanged` is always advertised — the proxy emits it when any upstream's tool
 *   list changes, even when no individual upstream supports the notification.
 * - All other capabilities (`resources`, `prompts`, `logging`, `completions`) are advertised
 *   iff at least one upstream advertises them. Nested booleans (`subscribe`, `listChanged`)
 *   are advertised iff at least one supporting upstream advertises them.
 */
export function aggregateCapabilities(
  upstreams: ReadonlyArray<ServerCapabilities | undefined>,
): ServerCapabilities {
  const aggregated: ServerCapabilities = {
    tools: { listChanged: true },
  };

  for (const caps of upstreams) {
    if (caps === undefined) continue;

    if (caps.resources !== undefined) {
      aggregated.resources ??= {};
      if (caps.resources.subscribe === true) {
        aggregated.resources.subscribe = true;
      }
      if (caps.resources.listChanged === true) {
        aggregated.resources.listChanged = true;
      }
    }

    if (caps.prompts !== undefined) {
      aggregated.prompts ??= {};
      if (caps.prompts.listChanged === true) {
        aggregated.prompts.listChanged = true;
      }
    }

    if (caps.logging !== undefined) {
      aggregated.logging ??= {};
    }

    if (caps.completions !== undefined) {
      aggregated.completions ??= {};
    }
  }

  return aggregated;
}
