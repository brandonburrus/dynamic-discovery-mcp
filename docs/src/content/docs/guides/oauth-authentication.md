---
title: OAuth Authentication
description: How dynmcp authenticates to remote MCPs that use OAuth, and how you log in and out of them.
---

Some remote MCPs require OAuth — you authorize once in your browser, and the server gives back a token that subsequent requests use. `dynmcp` handles this for any upstream MCP using the `streamable-http` or `sse` transport.

The shape is simple:

1. You run `dynmcp login <name>` once for each OAuth-protected MCP.
2. A browser tab opens, you click "Allow".
3. The token is saved to your operating system's keychain.
4. From then on, `dynmcp` automatically attaches the token to every request and silently refreshes it when it expires.

You only need to log in again if the token's refresh window expires, the upstream revokes it, or you explicitly run `dynmcp logout <name>`.

## When to log in

You'll know an MCP needs OAuth one of two ways:

- The first time the proxy tries to use it, you'll see an error like:

  > Upstream MCP "github" requires authorization. Run `dynmcp login github` from your terminal, then retry.

- The MCP's documentation tells you so up front.

Either way, the fix is the same.

## Logging in

```bash
dynmcp login <name>
```

`<name>` is the key under `mcp.<name>` in your config file. You need to be in a directory with an `mcp.json` (or `.mcp.json`), or pass `--config <path>` explicitly.

What happens, step by step:

1. `dynmcp` probes the upstream URL and reads the OAuth metadata from its 401 response.
2. If the server supports it, `dynmcp` registers a new OAuth client on the fly (no client ID setup required from you).
3. A local web server starts on `127.0.0.1` at a random port to receive the redirect.
4. Your default browser opens at the authorization URL. You click "Allow" (or whatever your server's consent screen calls it).
5. The browser redirects back to the local server, the code is exchanged for a token, and the token is stored in your keychain.
6. The local web server shuts down.

The whole thing typically takes under 30 seconds.

```
$ dynmcp login github
Probing https://api.githubcopilot.com/mcp for OAuth challenge...
Callback server listening on http://127.0.0.1:54321/callback
Opening browser for authorization: https://github.com/login/oauth/authorize?response_type=code&...
Waiting for browser callback (timeout 60s)...
Successfully authenticated "github".
```

### What if the browser doesn't open?

If `dynmcp` can't launch your browser (no `xdg-open` on a stripped-down Linux box, weird `$PATH` issues, etc.), it prints the URL to your terminal and waits. Copy it into a browser by hand and the flow continues normally.

### What if I'm on a remote machine with no browser?

`dynmcp login` requires an interactive browser session on the same machine. Forwarding ports over SSH to a local browser works in principle (the callback URL is `http://127.0.0.1:<port>/callback`), but it's not officially supported. Headless / CI authentication is out of scope.

## Logging out

```bash
dynmcp logout <name>
```

Deletes the local keychain entry. The OAuth server is **not** notified — the token might still be technically valid until it expires server-side. If you need to revoke immediately, do it from the server's own admin UI.

```
$ dynmcp logout github
Removed keychain credentials for "github".
```

`logout` is idempotent. Running it when no entry exists is a no-op success.

## How tokens are stored

Tokens live in your operating system's native credential store:

| Platform | Backing store |
|---|---|
| macOS | Keychain |
| Linux | libsecret (GNOME Keyring, KWallet, etc.) |
| Windows | Credential Manager |

`dynmcp` uses [`@napi-rs/keyring`](https://github.com/napi-rs/node-rs/tree/main/packages/keyring) for the native integration. Entries are stored under:

- **Service:** `dynmcp`
- **Account:** `<mcp-name>:<resource-server-origin>` (e.g. `github:https://api.githubcopilot.com`)
- **Value:** A JSON blob containing the access token, refresh token, expiry, and OAuth server metadata.

You can inspect (and delete) entries directly with your platform's keychain UI — search for "dynmcp" in Keychain Access on macOS, for example. There's intentionally no `dynmcp auth list` subcommand in v1; the OS UI is the authoritative view.

### Why include the server origin in the account name?

If you re-point an MCP at a different URL in your config (e.g. `https://api.githubcopilot.com/mcp` → `https://api.githubcopilot-staging.com/mcp`), the old keychain entry won't be found — `dynmcp` will treat it as if you'd never logged in and ask you to log in fresh. This avoids the surprising case where stale tokens get sent to a different server than the one they were issued for.

## Automatic refresh

OAuth tokens expire. When the cached access token is close to expiry (within 30 seconds), `dynmcp` silently exchanges the refresh token for a new access token, writes the result back to the keychain, and continues. You won't notice.

If the refresh fails (token revoked, refresh window elapsed, server returned an error), the next request that needs a token will fail with the "run `dynmcp login`" error. Re-run `login` and you're back in business.

## Pre-registered client credentials

By default, `dynmcp` uses [Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591) to register itself with the OAuth server on first login. No setup on your part.

If the server doesn't support DCR, or you have a corporate policy that requires pre-approved client IDs, you can supply credentials in the config file:

```json
{
  "mcp": {
    "github": {
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp",
      "auth": {
        "client_id": "${GITHUB_OAUTH_CLIENT_ID}",
        "client_secret": "${GITHUB_OAUTH_CLIENT_SECRET}",
        "scope": "repo"
      }
    }
  }
}
```

The `auth` block accepts:

| Field | Required | Description |
|---|---|---|
| `client_id` | Yes (if `auth` present) | The pre-registered OAuth client ID. |
| `client_secret` | No | The pre-registered client secret, for confidential clients. Omit for public (PKCE-only) clients. |
| `scope` | No | Space-separated OAuth scopes to request. Overrides the scopes advertised by the server's metadata. |

`auth` is only valid on `streamable-http` and `sse` entries. Putting it on a `stdio` entry is a startup error.

[Environment variable interpolation](/guides/environment-variables/) works inside the `auth` block — keep secrets out of the checked-in config file.

When the `auth` block is present, the `dynmcp login` flow uses those credentials directly and skips Dynamic Client Registration. Rotating the secret in config does **not** require `logout` first — config values take precedence over anything cached in the keychain.

## What happens during `load_mcp`

If you're using [dynamic discovery](/guides/dynamic-discovery/), an OAuth-protected MCP behaves naturally with `load_mcp`. The first time the agent calls it for an unauthenticated server, the load fails with the actionable "run `dynmcp login`" message. The lazy entry stays registered — once you log in, the next `load_mcp` call succeeds.

Auth-required failures **do not count toward the three-strike retry budget** for lazy MCPs. The agent can retry as many times as it takes; the MCP won't be silently evicted while you're walking to your terminal to log in.

## What's out of scope

Some things `dynmcp` deliberately does **not** do:

- **Device-code or client-credentials grants.** Only the authorization-code flow with PKCE is supported. That's the right fit for interactive desktop use, which is the only scenario `dynmcp` targets.
- **Opening a browser from inside the running proxy.** The proxy talks to your agent host over stdio; spawning browser windows from there would be hostile. All interactive flows happen via the separate `dynmcp login` invocation from your terminal.
- **Token revocation on logout.** `dynmcp logout` deletes the local keychain entry but does not call the server's revocation endpoint. Revoke from the server's admin UI if needed.
- **Multiple identities per MCP.** One token per `<mcp-name>:<origin>` pair. Switching accounts means `logout` followed by `login`.
- **Headless / CI authentication.** OAuth requires a real browser session.

## Troubleshooting

**"The upstream does not return a 401 challenge..."**
The MCP doesn't appear to require OAuth — there's nothing for `dynmcp login` to store. If you think the server *should* be OAuth-protected, double-check the URL or check the server's documentation.

**"Timed out after 60000ms waiting for the OAuth callback."**
The browser flow took too long. Common causes: you forgot to click "Allow", the consent screen needed something you didn't have, or the browser opened a tab you didn't notice. Re-run `dynmcp login <name>` and complete the flow within 60 seconds.

**"OAuth state mismatch on callback."**
The redirect arrived but the `state` parameter didn't match what we generated. Usually this means you had a stale tab from a previous `login` attempt sitting around. Close it and re-run.

**"Upstream MCP 'X' requires authorization. Run `dynmcp login X` ..."**
Either you've never logged in, or the refresh token is no longer valid. Run `dynmcp login <name>` and retry.
