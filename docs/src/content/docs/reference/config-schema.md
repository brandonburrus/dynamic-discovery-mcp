---
title: Config Schema
description: Full field-by-field reference for the dynmcp config file.
---

The `dynmcp` config file declares which upstream MCPs to proxy and how to connect to each one. The schema is defined and validated with [Zod](https://zod.dev/) at runtime, and published as a JSON Schema at `https://dynamicmcp.tools/config.json` for editor support.

JSON and YAML both work. The file extension picks the parser: `.json` for JSON, `.yml` or `.yaml` for YAML.

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `$schema` | `string` | No | Pointer to the published JSON Schema. Not interpreted at runtime — used purely for editor validation. |
| `env` | `"enable" \| "dotenv" \| "process" \| "disable"` | No | Controls environment variable interpolation. Default: `"enable"`. See [Environment Variables](/guides/environment-variables/). |
| `mcp` | `Record<string, McpEntry>` | Yes | Map of upstream MCPs, keyed by MCP name. Must contain at least one entry. |

The MCP name (the key under `mcp`) must match the regex `/^[a-z0-9][a-z0-9-]*$/`. It is used as the namespace prefix for all of that MCP's tools (e.g. tool `browser_navigate` under MCP `chrome-devtools` is exposed as `chrome-devtools/browser_navigate`).

## Common entry fields

These fields are valid on every entry, regardless of transport.

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `"stdio" \| "streamable-http" \| "sse"` | Yes | How `dynmcp` connects to this upstream MCP. |
| `description` | `string` | No | When present, marks this MCP as **lazy** ([dynamic discovery](/guides/dynamic-discovery/)). Must be a non-empty string after environment-variable interpolation. The presence of this field on **any** entry enables dynamic discovery for the proxy as a whole. |

## `stdio` transport

Spawns the upstream MCP as a child process.

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | Yes | The executable to spawn. |
| `args` | `string[]` | No | Arguments passed to the command. Default: `[]`. |
| `env` | `Record<string, string>` | No | Environment variables to set for the spawned process. |

```json
{
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}
```

## `streamable-http` transport

Connects to a remote MCP over HTTP.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | The URL of the remote MCP endpoint. Must be a valid `http://` or `https://` URL. |
| `headers` | `Record<string, string>` | No | HTTP headers included on every request. Typically used for auth (e.g. `Authorization: Bearer ${TOKEN}`). |

```json
{
  "aws-knowledge": {
    "transport": "streamable-http",
    "url": "https://knowledge-mcp.global.api.aws"
  }
}
```

## `sse` transport

Connects to a remote MCP over Server-Sent Events.

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | The URL of the remote SSE endpoint. Must be a valid `http://` or `https://` URL. |
| `headers` | `Record<string, string>` | No | HTTP headers included on the connection request. |

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

## Validation rules

The following are enforced at startup; violations are reported before any upstream MCP is contacted:

- The `mcp` map must contain at least one entry. An empty `mcp: {}` is a startup error.
- `stdio` entries must **not** include `url` or `headers`.
- `streamable-http` and `sse` entries must **not** include `command`, `args`, or `env`.
- `streamable-http` and `sse` `url` fields must be valid `http://` or `https://` URLs.
- `description`, if present, must be non-empty after environment-variable interpolation. An empty or whitespace-only `description` is a startup error.
- MCP names (keys under `mcp`) must match `/^[a-z0-9][a-z0-9-]*$/`.

## Editor support

Reference the published JSON Schema at the top of your config file and any editor with JSON Schema support (VS Code, JetBrains IDEs, Neovim with an LSP) will give you autocomplete and inline validation:

```json
{
  "$schema": "https://dynamicmcp.tools/config.json",
  "mcp": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

For YAML, use a comment-based hint instead:

```yaml
# yaml-language-server: $schema=https://dynamicmcp.tools/config.json
mcp:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

## Full example

```json
{
  "$schema": "https://dynamicmcp.tools/config.json",
  "env": "enable",
  "mcp": {
    "chrome-devtools": {
      "description": "Browser automation via Chrome DevTools Protocol. Navigate pages, take screenshots, inspect the DOM, run JavaScript in page context.",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "remote-http-mcp": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    },
    "remote-sse-mcp": {
      "transport": "sse",
      "url": "https://example.com/sse",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN:-anonymous}"
      }
    }
  }
}
```
