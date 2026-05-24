import process from "node:process";
import { KeychainStore } from "../auth/index.js";
import { loadConfig, type LoadConfigOptions } from "../config/index.js";
import type { McpConfig } from "../config/schema.js";
import { humanizeDuration, renderTable, truncate } from "./format.js";

const ENDPOINT_MAX_WIDTH = 48;

/**
 * Per-MCP summary as it appears in `dynmcp ls` output. The JSON shape mirrors this
 * structure closely; the text-table rendering picks a subset of fields.
 */
export type ListEntry = {
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  mode: "eager" | "lazy";
  endpoint: string;
  description?: string;
  auth: AuthStatus;
};

export type AuthStatus =
  | { kind: "n/a" }
  | { kind: "header" }
  | {
      kind: "oauth";
      status: "logged_in" | "not_logged_in";
      expiresInSeconds?: number;
      expiresAt?: number;
      alsoHeader?: boolean;
    };

export interface ListOptions extends LoadConfigOptions {
  /** Emit JSON instead of the aligned text table. */
  json?: boolean;
  /** Override the output writer (for tests). Defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
  /** Override the current time (Unix seconds) used to compute expires_in. Defaults to `Date.now() / 1000`. */
  now?: () => number;
}

/**
 * Implementation of `dynmcp ls`. Loads the config, derives a {@link ListEntry} per
 * configured upstream (querying the keychain for OAuth entries), and writes the
 * result as either an aligned text table or a JSON array.
 *
 * Pure config + keychain reads — no upstream connections are made.
 */
export async function list(options: ListOptions = {}): Promise<void> {
  const config = loadConfig({
    configPath: options.configPath,
    envFilePath: options.envFilePath,
  });
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const entries = buildEntries(config, now);

  if (options.json === true) {
    write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }

  if (entries.length === 0) {
    write("No upstream MCPs configured.\n");
    return;
  }

  const headers = ["NAME", "TRANSPORT", "MODE", "ENDPOINT", "AUTH"] as const;
  const rows = entries.map(entry => [
    entry.name,
    entry.transport,
    entry.mode,
    truncate(entry.endpoint, ENDPOINT_MAX_WIDTH),
    formatAuthStatus(entry.auth),
  ]);
  write(`${renderTable(headers, rows)}\n`);
}

function buildEntries(config: McpConfig, now: () => number): ListEntry[] {
  return Object.entries(config.mcp).map(([name, entry]) => {
    const mode: ListEntry["mode"] = entry.description !== undefined ? "lazy" : "eager";

    if (entry.transport === "stdio") {
      const command = entry.command;
      const args = (entry.args ?? []).join(" ");
      const endpoint = args.length > 0 ? `${command} ${args}` : command;
      const built: ListEntry = {
        name,
        transport: "stdio",
        mode,
        endpoint,
        auth: { kind: "n/a" },
      };
      if (entry.description !== undefined) built.description = entry.description;
      return built;
    }

    // streamable-http or sse
    const hasAuthHeader = hasBearerAuthHeader(entry.headers);
    const keychain = new KeychainStore(name, entry.url);
    const blob = keychain.get();

    let auth: AuthStatus;
    if (blob !== undefined) {
      const expiresInSeconds = blob.expires_at - now();
      auth = {
        kind: "oauth",
        status: "logged_in",
        expiresInSeconds,
        expiresAt: blob.expires_at,
      };
      if (hasAuthHeader) (auth as { alsoHeader?: boolean }).alsoHeader = true;
    } else if (hasAuthHeader) {
      auth = { kind: "header" };
    } else {
      auth = { kind: "oauth", status: "not_logged_in" };
    }

    const built: ListEntry = {
      name,
      transport: entry.transport,
      mode,
      endpoint: entry.url,
      auth,
    };
    if (entry.description !== undefined) built.description = entry.description;
    return built;
  });
}

function hasBearerAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (headers === undefined) return false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") return true;
  }
  return false;
}

function formatAuthStatus(auth: AuthStatus): string {
  switch (auth.kind) {
    case "n/a":
      return "n/a";
    case "header":
      return "header";
    case "oauth": {
      if (auth.status === "not_logged_in") return "oauth: not logged in";
      const duration = humanizeDuration(auth.expiresInSeconds ?? 0);
      const base = `oauth: logged in (expires in ${duration})`;
      return auth.alsoHeader === true ? `${base} (header also set)` : base;
    }
  }
}
