# src/auth

OAuth 2.1 client implementation for upstream MCPs that use the `streamable-http` or `sse` transports. Handles the interactive authorization-code flow (driven by the `dynmcp login` CLI subcommand), persistent token storage in the OS keychain, and silent in-process refresh from inside the proxy's runtime path.

Read SPEC.md § "Upstream OAuth" first — that's the authoritative behavior contract; this directory is the implementation.

## Module layout

| File | Purpose |
|---|---|
| `errors.ts` | `AuthRequiredError` + `isAuthRequiredError`. Thrown anywhere user interaction would be required at runtime; the orchestrator uses `isAuthRequiredError` to exempt these from the lazy-load retry budget. |
| `types.ts` | The `KeychainBlob` schema persisted per upstream, plus snapshot types (`AuthorizationServerSnapshot`, `ResourceMetadataSnapshot`, `DynamicClientRegistration`) and the `KEYCHAIN_BLOB_VERSION` sentinel. |
| `keychain-store.ts` | Wraps a single `@napi-rs/keyring` `Entry` with JSON-blob get/set/delete, version-stamping, and the `<mcp-name>:<resource-server-origin>` account-naming convention. |
| `browser.ts` | Cross-platform "open URL in default browser" used by the login flow. Detached child, ignored stdio. |
| `callback-server.ts` | One-shot local HTTP server bound to `127.0.0.1` on an ephemeral port. Serves only `GET /callback`, single-use, 60s timeout. Captures `code` + `state` from the redirect. |
| `oauth-provider.ts` | Two implementations of the MCP SDK's `OAuthClientProvider`: `ProxyOAuthProvider` (runtime, read-only-ish, throws `AuthRequiredError` on any interactive path) and `LoginOAuthProvider` (CLI login, stages pending DCR + discovery + verifier in memory and commits atomically on `saveTokens`). |
| `login.ts` | `dynmcp login <name>` orchestrator: 401 probe → discovery → optional DCR → browser → callback → token exchange. Pure error-propagation on every failure path; the keychain is touched only on a fully-successful token exchange. |
| `logout.ts` | `dynmcp logout <name>` — deletes the keychain entry. Idempotent. No network calls. |
| `index.ts` | Barrel re-exports. |

## Key invariants

- **Keychain writes are atomic and gated on token-exchange success.** During login the `LoginOAuthProvider` stages discovery metadata, DCR results, and the PKCE verifier in memory; `saveTokens` is the single call site that constructs the full `KeychainBlob` and writes it. If the flow fails before token exchange (network error, state mismatch, user cancellation, callback timeout), nothing is written.

- **Discovery is cached in the keychain blob.** `ProxyOAuthProvider.discoveryState()` reconstructs the SDK's `OAuthDiscoveryState` from the persisted snapshot so the runtime path never re-does RFC 9728 + RFC 8414 discovery on connect or refresh. The login flow explicitly returns `undefined` from `discoveryState()` to force fresh discovery on every login (in case endpoints changed).

- **The proxy never opens a browser.** `ProxyOAuthProvider.redirectToAuthorization`, `saveCodeVerifier`, and `codeVerifier` all throw `AuthRequiredError`. The SDK's `auth()` orchestrator catches that and surfaces it as the actionable "run `dynmcp login <name>`" message to the agent or operator.

- **Auth-required failures bypass the lazy-load retry budget** (`src/proxy/orchestrator.ts` → `runLoadPipeline`). They are operator-actionable, not transient. Counting them would silently evict an MCP the user just needs to log into.

- **Account identifier = `<mcp-name>:<resource-server-origin>`.** Re-pointing an MCP at a different URL in config does not silently authenticate against stale tokens — the keychain entry simply won't be found at the new origin. A fresh `dynmcp login` is required.

- **Config-supplied `auth.client_id` / `client_secret` take precedence over cached DCR.** When both exist for the same MCP, `clientInformation()` returns the config value. This lets operators rotate to manual registration without running `logout` first.

- **DCR results are stored alongside tokens in the same blob, not in a separate entry.** Simpler, fewer keychain entries, one atomic write per login. The trade-off is that `logout` discards the DCR registration too — re-login will register a fresh client.

- **The keychain blob carries a `version` sentinel** (`KEYCHAIN_BLOB_VERSION`). Reading a blob written under a different version returns `undefined` (treated as "no entry"), forcing re-login. Bump the constant and add migration logic when the schema changes incompatibly.

- **`token_endpoint_auth_method` derives from whether a `client_secret` is configured.** Public clients (no secret) advertise `"none"`; confidential clients advertise `"client_secret_basic"`. The SDK picks the actual method to use from the server's metadata at exchange time, but we still have to declare something compliant in our `clientMetadata`.

## SDK integration seam

The MCP SDK ships a complete OAuth client toolkit at `@modelcontextprotocol/sdk/client/auth.js`. We use:

- `auth(provider, { serverUrl, authorizationCode?, resourceMetadataUrl?, scope? })` — the orchestrator that drives every step (discovery → DCR → start auth → exchange). Called twice during login: once with no code (returns `'REDIRECT'`, triggers `redirectToAuthorization`), once with the captured code (returns `'AUTHORIZED'`, triggers `saveTokens`).
- `extractWWWAuthenticateParams(response)` — pulls `resource_metadata` URL from the 401 challenge that `login.ts` issues during its initial probe.

The HTTP transports (`StreamableHTTPClientTransport`, `SSEClientTransport`) accept an `authProvider` option; `src/proxy/transport-factory.ts` constructs a `ProxyOAuthProvider` per HTTP-based upstream and wires it in. The SDK calls our provider's methods automatically on connect, on outbound requests, and on 401 responses.

## What this directory deliberately does NOT do

- **Open a browser from inside the proxy process** — non-goal per SPEC.md. Always via `dynmcp login`.
- **Token revocation on logout** — non-goal in v1. We delete locally; the server is not notified.
- **Device-code grant, client-credentials grant** — non-goal in v1.
- **Multi-identity per MCP** — one keychain entry per `<mcp-name>:<origin>`.
- **Headless / CI auth** — non-goal; the flow requires a real browser session.
- **A `dynmcp auth status` / list subcommand** — operators can inspect the OS keychain UI directly; we may add one later without a spec change.

## Things worth knowing if you touch this

- **`KeychainStore` reads on every `tokens()` call.** The native keyring call is synchronous-ish but not free. The MCP SDK only calls `tokens()` once per outbound request (just before attaching the `Authorization` header), so caching at the provider level isn't worth the staleness risk. If profiling ever shows it as a hot spot, cache with a short TTL.

- **The MCP SDK's `OAuthTokens` shape uses `expires_in` (seconds-from-now), not `expires_at`.** `ProxyOAuthProvider.tokens()` computes `expires_in = max(0, blob.expires_at - now - REFRESH_SLACK_SECONDS)` so the SDK refreshes proactively. The 30-second slack reserves headroom for clock skew and request latency.

- **`saveTokens` on `ProxyOAuthProvider` requires an existing keychain entry.** Refresh paths always have one (we read the refresh token from there). If the entry is gone mid-refresh, we throw `AuthRequiredError` instead of writing a partial blob.

- **`LoginOAuthProvider.state()` is called by the SDK during `startAuthorization`.** We capture the generated value in `currentState` so the login orchestrator can validate the callback's `state` parameter against it before exchanging the code. State mismatch aborts the flow without ever touching the keychain.

- **The callback server's `awaitCallback` rejection happens synchronously inside the HTTP handler.** In tests, attach the `.rejects` assertion before firing the request that triggers it — otherwise Node logs an unhandled rejection warning.

- **Tests mock `@napi-rs/keyring` via `vi.mock` at the top of the file.** Real keychain access would prompt the user on macOS or fail on libsecret-less CI. The mock uses an in-memory `Map` keyed by `service+account`; clear it in `beforeEach`.
