/**
 * Subset of RFC 8414 authorization-server metadata that the proxy persists alongside
 * tokens. Discovered during `dynmcp login` and cached so subsequent refreshes don't
 * have to re-do RFC 9728 + RFC 8414 discovery on every connect.
 *
 * `revocation_endpoint` is intentionally omitted in v1 — token revocation on logout
 * is a non-goal. The endpoint can be added in a future blob version once revocation
 * support lands (bump `KEYCHAIN_BLOB_VERSION` and add migration logic).
 */
export type AuthorizationServerSnapshot = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
};

/**
 * Subset of RFC 9728 protected-resource metadata cached alongside tokens. The
 * `resource` URI is the canonical identifier the authorization server uses to scope
 * tokens — it may differ from the MCP server URL configured in `mcp.json`.
 */
export type ResourceMetadataSnapshot = {
  resource: string;
  authorization_servers: string[];
};

/**
 * Persisted Dynamic Client Registration result (RFC 7591). Present only when the
 * keychain entry was created without a pre-registered `auth` config block. If the
 * user later switches the upstream to pre-registered credentials in config, this
 * cached registration is ignored — config values take precedence in {@link
 * ProxyOAuthProvider.clientInformation}.
 *
 * RFC 7591 §3.2.1 registration-management fields (`registration_access_token`,
 * `registration_client_uri`) are omitted in v1 because we never modify or revoke
 * registrations. Future versions may add them; on storage shape change, bump
 * `KEYCHAIN_BLOB_VERSION` and add migration logic.
 */
export type DynamicClientRegistration = {
  client_id: string;
  client_secret?: string;
};

/**
 * The JSON blob persisted under `service=dynmcp, account=<mcp-name>:<origin>` in the
 * operating system's keychain. Written atomically after a successful token exchange or
 * refresh; on logout the entire entry is deleted.
 *
 * Schema is documented in SPEC.md § "Upstream OAuth > Keychain Storage". When the
 * shape changes incompatibly, bump {@link KEYCHAIN_BLOB_VERSION} and add migration
 * logic in {@link KeychainStore}.
 */
export type KeychainBlob = {
  version: typeof KEYCHAIN_BLOB_VERSION;
  access_token: string;
  token_type: "Bearer";
  expires_at: number;
  refresh_token?: string;
  scope_granted?: string;
  authorization_server: AuthorizationServerSnapshot;
  resource_metadata: ResourceMetadataSnapshot;
  dcr?: DynamicClientRegistration;
};

/**
 * Versioning sentinel embedded in every blob so we can detect (and eventually migrate
 * or reject) entries written by an older `dynmcp` version. Bump only when the schema
 * changes incompatibly.
 */
export const KEYCHAIN_BLOB_VERSION = 1 as const;

/**
 * Pre-registered OAuth client credentials supplied via the config file's optional
 * `auth: { client_id, client_secret?, scope? }` block. When present, {@link
 * ProxyOAuthProvider.clientInformation} returns these instead of the DCR cache and
 * {@link LoginOAuthProvider} skips the DCR step entirely.
 */
export type ConfigAuthOverrides = {
  client_id: string;
  client_secret?: string;
  scope?: string;
};
