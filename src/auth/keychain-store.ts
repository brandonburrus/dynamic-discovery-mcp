import { Entry } from "@napi-rs/keyring";
import { KEYCHAIN_BLOB_VERSION, type KeychainBlob } from "./types.js";

/**
 * Service name used for every entry written by `dynmcp`. Inspecting the OS keychain
 * UI, all proxy-managed credentials sort together under this name.
 */
export const KEYCHAIN_SERVICE = "dynmcp";

/**
 * Computes the keychain account identifier from an MCP name and its configured
 * upstream URL. Including the resource server origin guarantees that re-pointing an
 * MCP at a new URL in config does not silently authenticate against stale tokens —
 * the entry won't be found and a fresh `dynmcp login` is required.
 *
 * @param mcpName the MCP name as configured under `mcp.<name>` in the config file
 * @param serverUrl the configured upstream URL (origin is extracted; path is ignored)
 * @throws {TypeError} if `serverUrl` cannot be parsed as a URL
 */
export function buildKeychainAccount(mcpName: string, serverUrl: string): string {
  const origin = new URL(serverUrl).origin;
  return `${mcpName}:${origin}`;
}

/**
 * Type-safe wrapper around a single keychain entry. Each upstream MCP that requires
 * OAuth has at most one {@link KeychainStore} backing it; the store reads and writes
 * the entire {@link KeychainBlob} atomically so refreshing tokens never leaves a
 * partially-updated record on disk.
 *
 * The {@link Entry} from `@napi-rs/keyring` performs blocking native calls, so prefer
 * batching reads at the start of a request (the {@link ProxyOAuthProvider} does this
 * implicitly via the SDK's `auth()` flow). Tests can construct stores against a
 * different `service` to avoid clobbering the real keychain.
 */
export class KeychainStore {
  private readonly entry: Entry;

  constructor(
    public readonly mcpName: string,
    public readonly serverUrl: string,
    service: string = KEYCHAIN_SERVICE,
  ) {
    this.entry = new Entry(service, buildKeychainAccount(mcpName, serverUrl));
  }

  /**
   * Returns the parsed blob or `undefined` if no entry exists. Entries written under
   * a different {@link KeychainBlob.version} are treated as absent — the caller must
   * re-authenticate. Malformed JSON also returns `undefined` (corrupt entries are not
   * surfaced as errors; recovery is the same: re-auth).
   */
  get(): KeychainBlob | undefined {
    const raw = this.entry.getPassword();
    if (raw === null) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    if (!isCurrentVersionBlob(parsed)) {
      return undefined;
    }

    return parsed;
  }

  /**
   * Persists the blob atomically. Caller must construct a complete {@link
   * KeychainBlob} — partial updates are not supported. To mutate, call {@link get},
   * spread, and pass the result back to {@link set}.
   */
  set(blob: KeychainBlob): void {
    const stamped: KeychainBlob = { ...blob, version: KEYCHAIN_BLOB_VERSION };
    this.entry.setPassword(JSON.stringify(stamped));
  }

  /**
   * Deletes the entry. Returns `true` if an entry was present and removed, `false`
   * if there was nothing to delete. Idempotent: callers should treat both outcomes
   * as success (a no-op delete is not an error).
   */
  delete(): boolean {
    return this.entry.deletePassword();
  }
}

/**
 * Discriminates {@link KeychainBlob} from any other JSON value found in the keychain.
 * Only the version sentinel is checked — full structural validation would add code
 * surface for very little benefit since we control every write path.
 */
function isCurrentVersionBlob(value: unknown): value is KeychainBlob {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    (value as { version: unknown }).version === KEYCHAIN_BLOB_VERSION
  );
}
