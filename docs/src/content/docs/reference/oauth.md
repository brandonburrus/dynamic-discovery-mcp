---
title: OAuth
description: Field-by-field reference for OAuth configuration, keychain storage, and runtime behavior.
---

`dynmcp` implements OAuth 2.1 with PKCE for upstream MCPs that require authorization. This page is the reference; see the [OAuth Authentication guide](/guides/oauth-authentication/) for a walkthrough.

OAuth applies **only** to `streamable-http` and `sse` upstream transports. `stdio` upstreams are out of scope.

## Supported flows

| Feature | Supported |
|---|---|
| OAuth 2.1 authorization-code grant with PKCE (RFC 7636) | Yes — required |
| Protected Resource Metadata discovery (RFC 9728) | Yes — required |
| Authorization Server Metadata discovery (RFC 8414) | Yes — required |
| Dynamic Client Registration (RFC 7591) | Yes — used by default |
| Pre-registered client credentials via config | Yes — optional, see below |
| Access token refresh via refresh token | Yes — silent, in-process |
| Device-code grant (RFC 8628) | No |
| Client-credentials grant | No |
| Implicit grant | No (deprecated in OAuth 2.1) |

OAuth is **auto-detected**: when an upstream returns `HTTP 401 Unauthorized` with a `WWW-Authenticate: Bearer resource_metadata=<url>` header, the auth provider takes over. No config flag is required to "turn on" OAuth.

## `auth` config field

The `streamable-http` and `sse` transport entries accept an optional `auth` block to supply pre-registered OAuth client credentials. When omitted, `dynmcp` uses Dynamic Client Registration during `dynmcp login`.

| Field | Type | Required | Description |
|---|---|---|---|
| `auth.client_id` | `string` | Yes (if `auth` present) | Pre-registered OAuth client ID. Supplying this skips Dynamic Client Registration. |
| `auth.client_secret` | `string` | No | Pre-registered client secret for confidential clients. Omit for public (PKCE-only) clients. |
| `auth.scope` | `string` | No | Space-separated OAuth scopes to request. Overrides the scopes advertised by the protected-resource metadata. |

Validation rules:

- `auth` is rejected on `stdio` transport entries.
- `auth.client_id`, if present, must be a non-empty string after [environment variable interpolation](/guides/environment-variables/).
- Unknown keys inside `auth` are rejected (strict schema).
- Authorization-server endpoint URLs (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`) are **always** discovered via RFC 8414 metadata. There is no config override for them.

```json
{
  "mcp": {
    "linear": {
      "transport": "streamable-http",
      "url": "https://mcp.linear.app",
      "auth": {
        "client_id": "${LINEAR_OAUTH_CLIENT_ID}",
        "client_secret": "${LINEAR_OAUTH_CLIENT_SECRET}",
        "scope": "read write"
      }
    }
  }
}
```

When both an `auth` config block and a cached DCR registration exist for the same MCP, the config values win.

## CLI subcommands

### `dynmcp login <name>`

Runs the interactive OAuth flow for one configured upstream MCP and persists the resulting tokens to the keychain.

- `<name>` must match a key under `mcp.<name>` in the config file.
- The named entry must use `streamable-http` or `sse` transport. `stdio` is rejected.
- Requires config file mode — there is no `login` for single-MCP (`--`) mode.
- Accepts the same `--config` / `-c` and `--env` / `-e` flags as the proxy command.

Exit codes:

- `0` on successful authentication.
- Non-zero on any failure (unknown name, wrong transport, no 401 challenge, callback timeout, state mismatch, token exchange error). Error message printed to stderr.

Re-running `login` against an already-authenticated MCP simply overwrites the cached entry with a fresh token. There is no separate `refresh` subcommand — silent refresh is handled in-process by the proxy.

### `dynmcp logout <name>`

Deletes the keychain entry for one configured upstream MCP. No network calls; the OAuth server is not notified.

- Same validation rules as `login` (`<name>` must exist; must be http/sse).
- Idempotent — a missing entry is treated as success.

## Keychain storage

| Aspect | Value |
|---|---|
| Library | [`@napi-rs/keyring`](https://github.com/napi-rs/node-rs/tree/main/packages/keyring) (macOS Keychain, Linux libsecret, Windows Credential Manager) |
| Service | `dynmcp` |
| Account | `<mcp-name>:<resource-server-origin>` — e.g. `linear:https://mcp.linear.app` |
| Value | JSON blob containing the access token, refresh token, expiry, and OAuth server / resource metadata snapshot |

The account format includes the resource server origin so that re-pointing an MCP at a different URL in config does not silently authenticate against stale tokens — the entry won't be found and a fresh `dynmcp login` is required.

### Blob shape

```ts
{
  version: 1,
  access_token: string,
  token_type: "Bearer",
  expires_at: number,              // Unix epoch seconds
  refresh_token?: string,          // present iff server issued one
  scope_granted?: string,          // space-separated scopes
  authorization_server: {
    issuer: string,
    authorization_endpoint: string,
    token_endpoint: string,
    registration_endpoint?: string
  },
  resource_metadata: {
    resource: string,              // canonical resource URI
    authorization_servers: string[]
  },
  dcr?: {                          // present iff DCR was used
    client_id: string,
    client_secret?: string         // present iff confidential client
  }
}
```

Configured `auth.client_id` / `auth.client_secret` are read from config at use time and **not** mirrored into the keychain. Rotating credentials in config does not require a logout.

## Local callback server

`dynmcp login` runs a one-shot HTTP server to receive the OAuth redirect.

| Aspect | Value |
|---|---|
| Bind address | `127.0.0.1` only |
| Port | OS-assigned ephemeral |
| Path | `/callback` (only path served) |
| Methods | `GET` only |
| Lifetime | Started before opening the browser; shut down on first valid callback or after 60-second timeout |
| Other paths | Return `404` |
| Other methods | Return `405` |

The redirect URI is reconstructed each flow from the actual bound port. When DCR is in use, this URI is registered dynamically with the OAuth server. When pre-registered credentials are used, you (the operator) must ensure your pre-registered client permits the loopback redirect pattern.

## Proxy runtime behavior

When the proxy is running, every HTTP / SSE upstream is wired with an internal OAuth client provider. On each outbound request:

- If a valid cached token exists, it's attached as `Authorization: Bearer <token>`.
- If the token is within 30 seconds of expiry, a refresh is attempted silently against the token endpoint using the cached refresh token. The new token replaces the old one in the keychain atomically.
- If the request returns 401 mid-session, exactly one silent refresh + retry is attempted.

When credentials are missing or invalid:

| Context | Behavior |
|---|---|
| During `load_mcp` (lazy upstream) | Returns an error to the agent: *"Upstream MCP 'X' requires authorization. Run `dynmcp login X` from your terminal, then retry `load_mcp`."* The lazy entry stays registered; this failure **does not** count toward the three-strike retry budget. |
| During startup (eager upstream) | The proxy fails to start with the same actionable message. |
| During normal in-session use (loaded upstream, post-refresh 401) | The offending request returns an error with the actionable message. The MCP stays connected; subsequent auth-requiring requests will continue to fail until the user re-runs `dynmcp login`. The proxy does not disconnect or evict. |

The proxy itself **never** opens a browser. All interactive auth flows happen out-of-band via `dynmcp login`.

## Concurrency

`dynmcp login <name>` and `dynmcp logout <name>` must not run concurrently against the same `<name>`. Keychain writes are not transactional across processes; running two `login`s for the same MCP races to overwrite the entry. This is documented but not enforced.

Inside the proxy, silent refresh is serialized per-MCP so bursts of host requests don't all trigger concurrent refresh attempts.

## Non-goals

The following are explicitly out of scope:

- OAuth device-code grant, client-credentials grant, or any non-authorization-code OAuth flow.
- Browser-launched OAuth from within the proxy process.
- Token revocation on `dynmcp logout`. Local-only delete; the server is not notified.
- Multiple identities per upstream MCP. One keychain entry per `<mcp-name>:<resource-server-origin>` pair.
- Headless / CI authentication. OAuth flows require an interactive browser session.

See [`SPEC.md`](https://github.com/brandonburrus/dynamic-discovery-mcp/blob/main/SPEC.md) § "Upstream OAuth" for the authoritative implementation contract.
