import { randomBytes } from "node:crypto";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthRequiredError } from "./errors.js";
import type { KeychainStore } from "./keychain-store.js";
import type {
  AuthorizationServerSnapshot,
  ConfigAuthOverrides,
  KeychainBlob,
  ResourceMetadataSnapshot,
} from "./types.js";
import { KEYCHAIN_BLOB_VERSION } from "./types.js";

/**
 * Client identity advertised in the OAuth client metadata document. Sent during DCR
 * (RFC 7591) and used to construct the `client_name` shown on the consent screen of
 * compliant authorization servers.
 */
const CLIENT_NAME = "dynmcp";

/**
 * Standard OAuth software identifier per RFC 7591 §2. Static across releases so
 * authorization servers that pin clients to a `software_id` can match them.
 */
const SOFTWARE_ID = "dynmcp";

/**
 * Number of seconds before a cached access token's `expires_at` at which the SDK
 * will be told the token is already expired, prompting a refresh. The MCP SDK
 * triggers refresh when `expires_in <= 0`, so subtracting this slack reserves headroom
 * for clock skew and the round-trip latency of the next request.
 */
const REFRESH_SLACK_SECONDS = 30;

/**
 * Shared base implementing the bookkeeping that's identical between runtime use
 * ({@link ProxyOAuthProvider}) and interactive login ({@link LoginOAuthProvider}):
 * keychain reads/writes, blob ↔ {@link OAuthTokens} conversion, and discovery-state
 * snapshotting. Subclasses provide the interaction-mode-specific behaviour.
 */
abstract class BaseOAuthProvider implements OAuthClientProvider {
  constructor(
    protected readonly mcpName: string,
    protected readonly keychain: KeychainStore,
    protected readonly configAuth: ConfigAuthOverrides | undefined,
  ) {}

  abstract get redirectUrl(): string | URL | undefined;
  abstract get clientMetadata(): OAuthClientMetadata;
  abstract redirectToAuthorization(url: URL): Promise<void> | void;
  abstract saveCodeVerifier(verifier: string): Promise<void> | void;
  abstract codeVerifier(): Promise<string> | string;

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.configAuth !== undefined) {
      const info: OAuthClientInformationMixed = { client_id: this.configAuth.client_id };
      if (this.configAuth.client_secret !== undefined) {
        info.client_secret = this.configAuth.client_secret;
      }
      return info;
    }
    const blob = this.keychain.get();
    if (blob?.dcr === undefined) return undefined;
    const info: OAuthClientInformationMixed = { client_id: blob.dcr.client_id };
    if (blob.dcr.client_secret !== undefined) {
      info.client_secret = blob.dcr.client_secret;
    }
    return info;
  }

  tokens(): OAuthTokens | undefined {
    const blob = this.keychain.get();
    if (blob === undefined) return undefined;
    const remaining = Math.max(
      0,
      blob.expires_at - Math.floor(Date.now() / 1000) - REFRESH_SLACK_SECONDS,
    );
    const tokens: OAuthTokens = {
      access_token: blob.access_token,
      token_type: blob.token_type,
      expires_in: remaining,
    };
    if (blob.refresh_token !== undefined) tokens.refresh_token = blob.refresh_token;
    if (blob.scope_granted !== undefined) tokens.scope = blob.scope_granted;
    return tokens;
  }

  abstract saveTokens(tokens: OAuthTokens): Promise<void> | void;

  /**
   * Builds the {@link OAuthDiscoveryState} the SDK can use to skip rediscovery,
   * reconstructed from the cached keychain blob. Returns `undefined` when there is
   * no cached blob (e.g. fresh login flow before saveTokens fires).
   */
  protected buildDiscoveryStateFromBlob(
    blob: KeychainBlob | undefined,
  ): OAuthDiscoveryState | undefined {
    if (blob === undefined) return undefined;
    return {
      authorizationServerUrl: blob.authorization_server.issuer,
      authorizationServerMetadata: {
        issuer: blob.authorization_server.issuer,
        authorization_endpoint: blob.authorization_server.authorization_endpoint,
        token_endpoint: blob.authorization_server.token_endpoint,
        ...(blob.authorization_server.registration_endpoint !== undefined
          ? { registration_endpoint: blob.authorization_server.registration_endpoint }
          : {}),
        response_types_supported: ["code"],
      },
      resourceMetadata: {
        resource: blob.resource_metadata.resource,
        authorization_servers: blob.resource_metadata.authorization_servers,
      },
    };
  }
}

/**
 * The {@link OAuthClientProvider} wired into the proxy's HTTP / SSE transports at
 * runtime. Read-mostly: it serves cached tokens, supports silent refresh, and
 * deletes credentials on invalidation. Any path that would require user interaction
 * (initial authorization, code-verifier handling) throws {@link AuthRequiredError}
 * with an actionable message — the proxy never opens a browser.
 *
 * Refreshed tokens are persisted back to the keychain atomically via {@link
 * saveTokens}. The {@link discoveryState} method returns the metadata snapshot
 * captured during the original `dynmcp login`, letting the SDK avoid re-doing RFC
 * 9728 + RFC 8414 discovery on every connect.
 */
export class ProxyOAuthProvider extends BaseOAuthProvider {
  get redirectUrl(): undefined {
    // The proxy cannot redirect. If the SDK asks for a redirect URL it means we
    // would need to start an interactive flow we cannot complete — that path
    // routes through `redirectToAuthorization` below which throws.
    return undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      software_id: SOFTWARE_ID,
      redirect_uris: [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        this.configAuth?.client_secret !== undefined ? "client_secret_basic" : "none",
      ...(this.configAuth?.scope !== undefined ? { scope: this.configAuth.scope } : {}),
    };
  }

  saveTokens(tokens: OAuthTokens): void {
    const existing = this.keychain.get();
    if (existing === undefined) {
      // Refresh succeeded against an entry we no longer have? Treat as fatal:
      // re-login is required. This shouldn't happen because the only way we got
      // a valid refresh_token to send was reading an entry that just existed.
      throw new AuthRequiredError(this.mcpName);
    }
    const expiresAt =
      tokens.expires_in !== undefined
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : existing.expires_at;
    const updated: KeychainBlob = {
      ...existing,
      access_token: tokens.access_token,
      token_type: (tokens.token_type ?? "Bearer") as "Bearer",
      expires_at: expiresAt,
      refresh_token: tokens.refresh_token ?? existing.refresh_token,
      ...(tokens.scope !== undefined ? { scope_granted: tokens.scope } : {}),
    };
    this.keychain.set(updated);
  }

  redirectToAuthorization(_url: URL): never {
    throw new AuthRequiredError(this.mcpName);
  }

  saveCodeVerifier(_verifier: string): never {
    throw new AuthRequiredError(this.mcpName);
  }

  codeVerifier(): never {
    throw new AuthRequiredError(this.mcpName);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.buildDiscoveryStateFromBlob(this.keychain.get());
  }

  invalidateCredentials(_scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    // For all invalidation scopes, the simplest and safest action is to delete the
    // entire keychain entry and require the user to re-login. Partial invalidation
    // would leave behind stale fields that the SDK might mix with fresh ones.
    this.keychain.delete();
  }
}

/**
 * Per-flow state assembled during `dynmcp login` and committed to the keychain
 * atomically in {@link LoginOAuthProvider.saveTokens}. Holding partial results in
 * memory until token exchange succeeds means a failed login leaves no trace on disk.
 */
type PendingLoginState = {
  dcr?: OAuthClientInformationFull;
  discovery?: OAuthDiscoveryState;
  codeVerifier?: string;
  state?: string;
};

/**
 * Callback contract for the interactive bits of {@link LoginOAuthProvider} so the
 * login orchestrator can inject a browser-opener and test code can substitute a
 * no-op. Each handler runs once per login flow.
 */
export type LoginProviderCallbacks = {
  /**
   * Called when the SDK has constructed the authorization URL. Implementations
   * typically open the URL in the user's browser; the login orchestrator then
   * waits on its callback server.
   */
  onAuthorizationUrl(url: URL): Promise<void> | void;
};

/**
 * The {@link OAuthClientProvider} used during `dynmcp login`. Fully interactive: it
 * holds an in-memory {@link PendingLoginState} that is only committed to the keychain
 * once {@link saveTokens} fires (i.e. token exchange succeeded). On any earlier
 * failure the in-memory state is discarded — nothing is persisted — matching the
 * spec's "no keychain write occurs" failure-path guarantee.
 */
export class LoginOAuthProvider extends BaseOAuthProvider {
  private readonly redirectUriString: string;
  private readonly pending: PendingLoginState = {};
  private readonly callbacks: LoginProviderCallbacks;

  constructor(opts: {
    mcpName: string;
    keychain: KeychainStore;
    configAuth: ConfigAuthOverrides | undefined;
    redirectUri: string;
    callbacks: LoginProviderCallbacks;
  }) {
    super(opts.mcpName, opts.keychain, opts.configAuth);
    this.redirectUriString = opts.redirectUri;
    this.callbacks = opts.callbacks;
  }

  get redirectUrl(): string {
    return this.redirectUriString;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      software_id: SOFTWARE_ID,
      redirect_uris: [this.redirectUriString],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        this.configAuth?.client_secret !== undefined ? "client_secret_basic" : "none",
      ...(this.configAuth?.scope !== undefined ? { scope: this.configAuth.scope } : {}),
    };
  }

  state(): string {
    if (this.pending.state !== undefined) return this.pending.state;
    const generated = randomBytes(32).toString("base64url");
    this.pending.state = generated;
    return generated;
  }

  /** The state value generated for this flow, for the callback handler to verify. */
  get currentState(): string | undefined {
    return this.pending.state;
  }

  override clientInformation(): OAuthClientInformationMixed | undefined {
    // Pending DCR (just registered) wins over config and keychain. Otherwise fall
    // back to base behaviour (config → keychain.dcr).
    if (this.pending.dcr !== undefined) {
      const info: OAuthClientInformationMixed = { client_id: this.pending.dcr.client_id };
      if (this.pending.dcr.client_secret !== undefined) {
        info.client_secret = this.pending.dcr.client_secret;
      }
      return info;
    }
    return super.clientInformation();
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    // Cast: the SDK only invokes saveClientInformation with the full DCR response,
    // not just a mixed slice. Treat the input as full and stash it pending the
    // atomic write in `saveTokens`.
    this.pending.dcr = info as OAuthClientInformationFull;
  }

  override saveTokens(tokens: OAuthTokens): void {
    const discovery =
      this.pending.discovery ?? this.buildDiscoveryStateFromBlob(this.keychain.get());
    if (discovery === undefined) {
      throw new Error(
        `Cannot persist tokens for "${this.mcpName}": no discovery state captured during the flow.`,
      );
    }
    if (discovery.authorizationServerMetadata === undefined) {
      throw new Error(
        `Cannot persist tokens for "${this.mcpName}": authorization server metadata not available.`,
      );
    }
    if (discovery.resourceMetadata === undefined) {
      throw new Error(
        `Cannot persist tokens for "${this.mcpName}": protected resource metadata not available.`,
      );
    }

    const expiresAt =
      tokens.expires_in !== undefined
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : Math.floor(Date.now() / 1000) + 3600;

    const authorizationServer: AuthorizationServerSnapshot = {
      issuer: discovery.authorizationServerMetadata.issuer ?? discovery.authorizationServerUrl,
      authorization_endpoint: discovery.authorizationServerMetadata.authorization_endpoint,
      token_endpoint: discovery.authorizationServerMetadata.token_endpoint,
      ...(discovery.authorizationServerMetadata.registration_endpoint !== undefined
        ? { registration_endpoint: discovery.authorizationServerMetadata.registration_endpoint }
        : {}),
    };
    const resourceMetadata: ResourceMetadataSnapshot = {
      resource: discovery.resourceMetadata.resource,
      authorization_servers: discovery.resourceMetadata.authorization_servers ?? [],
    };

    const blob: KeychainBlob = {
      version: KEYCHAIN_BLOB_VERSION,
      access_token: tokens.access_token,
      token_type: (tokens.token_type ?? "Bearer") as "Bearer",
      expires_at: expiresAt,
      ...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.scope !== undefined ? { scope_granted: tokens.scope } : {}),
      authorization_server: authorizationServer,
      resource_metadata: resourceMetadata,
      ...(this.pending.dcr !== undefined
        ? {
            dcr: {
              client_id: this.pending.dcr.client_id,
              ...(this.pending.dcr.client_secret !== undefined
                ? { client_secret: this.pending.dcr.client_secret }
                : {}),
            },
          }
        : {}),
    };

    this.keychain.set(blob);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.callbacks.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.pending.codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (this.pending.codeVerifier === undefined) {
      throw new Error("Code verifier requested before it was saved.");
    }
    return this.pending.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.pending.discovery = state;
  }

  /**
   * Force a fresh RFC 9728 + RFC 8414 discovery for every login flow. We intentionally
   * do NOT pre-seed from the keychain on login — if endpoints changed since the last
   * login, we want to pick them up now and persist the new snapshot.
   */
  discoveryState(): undefined {
    return undefined;
  }
}
