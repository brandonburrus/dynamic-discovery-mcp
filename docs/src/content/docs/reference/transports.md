---
title: Transports
description: The three transport types dynmcp uses to connect to upstream MCPs.
---

`dynmcp` can connect to upstream MCPs using one of three transports. You pick which per entry in your config file via the `transport` field. The host-facing side is always stdio.

| Transport | Fields | Use case |
|---|---|---|
| [`stdio`](#stdio) | `command`, `args?`, `env?` | Local MCPs launched as child processes. |
| [`streamable-http`](#streamable-http) | `url`, `headers?` | Remote MCPs reachable over HTTP. |
| [`sse`](#sse) | `url`, `headers?` | Remote MCPs reachable over Server-Sent Events. |

## stdio

Spawns the upstream MCP as a child process. This is the most common transport; most MCPs on npm ship a stdio binary.

```json
{
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `command` | Yes | Executable to spawn. |
| `args` | No | String array. Default: `[]`. |
| `env` | No | Map of env vars to set for the spawned process. |

### Lifecycle

- The process spawns at startup for eager MCPs, or at `load_mcp` time for lazy MCPs.
- The child's stderr is forwarded to `dynmcp`'s own stderr so you can see what it says.
- On shutdown, the process is terminated as part of the standard teardown.

## streamable-http

Connects to a remote MCP over HTTP. Use this for hosted MCPs that expose an HTTP endpoint.

```json
{
  "aws-knowledge": {
    "transport": "streamable-http",
    "url": "https://knowledge-mcp.global.api.aws"
  }
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `url` | Yes | Full URL of the MCP endpoint. Must be a valid `http://` or `https://` URL. |
| `headers` | No | Map of HTTP headers included on every request. |
| `auth` | No | Pre-registered OAuth client credentials. See [Auth](#auth). |

### Auth

There are two ways to authenticate to a `streamable-http` (or `sse`) upstream, depending on what the server supports:

**1. Static bearer token via `headers`.** Use when the server accepts a long-lived API key or PAT in the `Authorization` header. Combine with [environment variable interpolation](/guides/environment-variables/) to keep secrets out of the config file:

```json
{
  "remote": {
    "transport": "streamable-http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

**2. OAuth 2.1 with PKCE.** Use when the server returns a 401 challenge with OAuth metadata. `dynmcp` handles the full authorization-code flow via the [`dynmcp login`](/reference/cli/#oauth-login--logout) subcommand and persists tokens to your OS keychain. No config change is required for the auto-detected default; supply an optional `auth` block to override Dynamic Client Registration with pre-registered credentials:

```json
{
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
```

See the [OAuth Authentication guide](/guides/oauth-authentication/) for the walkthrough and the [OAuth reference](/reference/oauth/) for keychain storage details and runtime behavior.

## sse

Connects to a remote MCP over Server-Sent Events. Similar shape to `streamable-http`, just for endpoints that use the SSE transport variant.

```json
{
  "remote-sse": {
    "transport": "sse",
    "url": "https://example.com/sse",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `url` | Yes | Full URL of the SSE endpoint. Must be a valid `http://` or `https://` URL. |
| `headers` | No | Map of HTTP headers included on the connection request. |
| `auth` | No | Pre-registered OAuth client credentials. Identical semantics to the [`streamable-http` auth block](#auth). |

## Mixing transports

You can mix transports freely in a single config. Each entry's `transport` discriminator is independent of the others, so a stdio MCP next to a streamable-http MCP next to an sse MCP is fine.

## Mutual exclusion

Each transport's fields are mutually exclusive. The Zod schema rejects mixing them at startup:

- `stdio` entries can't include `url`, `headers`, or `auth`.
- `streamable-http` and `sse` entries can't include `command`, `args`, or `env`.

A misconfiguration produces a startup error before any connection is attempted.
