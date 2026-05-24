import process from "node:process";
import { auth, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig, type LoadConfigOptions } from "../config/index.js";
import type { McpConfig } from "../config/schema.js";
import { openUrl } from "./browser.js";
import { CallbackServer } from "./callback-server.js";
import { KeychainStore } from "./keychain-store.js";
import { LoginOAuthProvider } from "./oauth-provider.js";
import type { ConfigAuthOverrides } from "./types.js";

/**
 * Default browser-callback timeout. The OAuth dance is "open browser, click consent,
 * wait for redirect"; 60s is a generous bound for someone actively at their keyboard
 * and short enough that a closed tab or wrong browser fails fast.
 */
const CALLBACK_TIMEOUT_MS = 60_000;

export interface LoginOptions extends LoadConfigOptions {
  /** Name of the MCP under the config's `mcp.<name>` key. */
  mcpName: string;
  /** Hook for tests to substitute a no-op browser opener. Defaults to {@link openUrl}. */
  openInBrowser?: (url: string) => Promise<void>;
  /** Hook for tests to write status to a buffer rather than stderr. */
  writeStatus?: (message: string) => void;
}

/**
 * Runs the interactive OAuth authorization-code flow for a single configured
 * upstream MCP and persists the resulting tokens to the OS keychain. Mirrors the
 * step-by-step behaviour specified in SPEC.md § "`dynmcp login <name>`".
 *
 * Side-effect free up to the moment the token endpoint returns successfully — any
 * earlier failure leaves the keychain untouched and discards any in-flight DCR
 * registration.
 *
 * @throws Error with a user-actionable message on every documented failure path
 *   (wrong transport, unknown name, no 401 challenge, callback timeout, state
 *   mismatch, token exchange failure). Callers should surface `error.message` and
 *   exit non-zero.
 */
export async function login(options: LoginOptions): Promise<void> {
  const config = loadConfig({
    configPath: options.configPath,
    envFilePath: options.envFilePath,
  });
  const entry = resolveOAuthCapableEntry(config, options.mcpName);
  const writeStatus = options.writeStatus ?? defaultStatusWriter;
  const openInBrowser = options.openInBrowser ?? openUrl;

  writeStatus(`Probing ${entry.url} for OAuth challenge...\n`);
  const resourceMetadataUrl = await probeFor401ResourceMetadata(entry.url);
  if (resourceMetadataUrl === undefined) {
    throw new Error(
      `Upstream "${options.mcpName}" did not return a 401 challenge with a ` +
        `WWW-Authenticate \`resource_metadata\` URL. The server does not appear to require ` +
        `OAuth; no credentials stored.`,
    );
  }

  const keychain = new KeychainStore(options.mcpName, entry.url);
  const callbackServer = new CallbackServer();
  await callbackServer.start();
  writeStatus(`Callback server listening on ${callbackServer.redirectUri}\n`);

  try {
    const provider = new LoginOAuthProvider({
      mcpName: options.mcpName,
      keychain,
      configAuth: configAuthFromEntry(entry),
      redirectUri: callbackServer.redirectUri,
      callbacks: {
        onAuthorizationUrl: async url => {
          writeStatus(`Opening browser for authorization: ${url.toString()}\n`);
          try {
            await openInBrowser(url.toString());
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            writeStatus(
              `Failed to launch browser (${reason}). Open this URL manually:\n  ${url.toString()}\n`,
            );
          }
        },
      },
    });

    const firstResult = await auth(provider, {
      serverUrl: entry.url,
      resourceMetadataUrl,
      ...(entry.auth?.scope !== undefined ? { scope: entry.auth.scope } : {}),
    });

    if (firstResult === "AUTHORIZED") {
      writeStatus(`Already authorized for "${options.mcpName}"; no changes made.\n`);
      return;
    }

    writeStatus(`Waiting for browser callback (timeout ${CALLBACK_TIMEOUT_MS / 1000}s)...\n`);
    const { code, state: receivedState } = await callbackServer.awaitCallback(CALLBACK_TIMEOUT_MS);

    const expectedState = provider.currentState;
    if (expectedState === undefined || receivedState !== expectedState) {
      throw new Error(
        "OAuth state mismatch on callback. Possible CSRF attempt or stale browser tab; " +
          "not exchanging the authorization code.",
      );
    }

    const secondResult = await auth(provider, {
      serverUrl: entry.url,
      authorizationCode: code,
      resourceMetadataUrl,
      ...(entry.auth?.scope !== undefined ? { scope: entry.auth.scope } : {}),
    });

    if (secondResult !== "AUTHORIZED") {
      throw new Error(`Token exchange did not return AUTHORIZED (got ${secondResult}).`);
    }

    writeStatus(`Successfully authenticated "${options.mcpName}".\n`);
  } finally {
    await callbackServer.stop();
  }
}

/**
 * Validates that the named MCP exists in the config and that it is an HTTP-based
 * transport (stdio is out of scope for OAuth). Returns the typed entry on success.
 */
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

function configAuthFromEntry(
  entry: Extract<McpConfig["mcp"][string], { transport: "streamable-http" } | { transport: "sse" }>,
): ConfigAuthOverrides | undefined {
  if (entry.auth === undefined) return undefined;
  const overrides: ConfigAuthOverrides = { client_id: entry.auth.client_id };
  if (entry.auth.client_secret !== undefined) overrides.client_secret = entry.auth.client_secret;
  if (entry.auth.scope !== undefined) overrides.scope = entry.auth.scope;
  return overrides;
}

/**
 * Performs an unauthenticated probe of the upstream URL to extract the RFC 9728
 * `resource_metadata` URL from the resulting `WWW-Authenticate` header. Returns
 * `undefined` if the server responds with anything other than 401, which the caller
 * surfaces as the spec-defined "this MCP does not require OAuth" error.
 *
 * The probe uses HTTP GET with no body — most MCP servers will reject it for
 * protocol reasons but still emit the 401 + challenge first, which is all we need.
 * Network errors propagate so the caller's actionable error message includes them.
 */
async function probeFor401ResourceMetadata(serverUrl: string): Promise<URL | undefined> {
  let response: Response;
  try {
    response = await fetch(serverUrl, { method: "GET", redirect: "manual" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to reach ${serverUrl}: ${reason}`);
  }
  if (response.status !== 401) {
    return undefined;
  }
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  return resourceMetadataUrl;
}

function defaultStatusWriter(message: string): void {
  process.stderr.write(message);
}
