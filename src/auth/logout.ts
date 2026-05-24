import process from "node:process";
import { loadConfig, type LoadConfigOptions } from "../config/index.js";
import type { McpConfig } from "../config/schema.js";
import { KeychainStore } from "./keychain-store.js";

export interface LogoutOptions extends LoadConfigOptions {
  /** Name of the MCP under the config's `mcp.<name>` key. */
  mcpName: string;
  /** Hook for tests to write status to a buffer rather than stderr. */
  writeStatus?: (message: string) => void;
}

/**
 * Removes the keychain entry for a single configured upstream MCP. Idempotent — a
 * missing entry is treated as success. No network calls; the upstream is not notified.
 * Token revocation is intentionally out of scope (see SPEC.md § Non-Goals).
 *
 * @throws Error with a user-actionable message if the MCP name is unknown or the
 *   configured transport is not OAuth-capable.
 */
export async function logout(options: LogoutOptions): Promise<void> {
  const config = loadConfig({
    configPath: options.configPath,
    envFilePath: options.envFilePath,
  });
  const entry = resolveOAuthCapableEntry(config, options.mcpName);
  const writeStatus = options.writeStatus ?? defaultStatusWriter;

  const keychain = new KeychainStore(options.mcpName, entry.url);
  const removed = keychain.delete();
  if (removed) {
    writeStatus(`Removed keychain credentials for "${options.mcpName}".\n`);
  } else {
    writeStatus(
      `No keychain credentials were stored for "${options.mcpName}"; nothing to remove.\n`,
    );
  }
}

function resolveOAuthCapableEntry(
  config: McpConfig,
  mcpName: string,
): Extract<McpConfig["mcp"][string], { transport: "streamable-http" } | { transport: "sse" }> {
  const entry = config.mcp[mcpName];
  if (entry === undefined) {
    const available = Object.keys(config.mcp).sort().join(", ");
    throw new Error(`Unknown MCP "${mcpName}". Configured MCPs: ${available || "(none)"}.`);
  }
  if (entry.transport !== "streamable-http" && entry.transport !== "sse") {
    throw new Error(
      `MCP "${mcpName}" uses the "${entry.transport}" transport; OAuth is only supported ` +
        `for streamable-http and sse upstreams.`,
    );
  }
  return entry;
}

function defaultStatusWriter(message: string): void {
  process.stderr.write(message);
}
