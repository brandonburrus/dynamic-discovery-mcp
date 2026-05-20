---
title: load_mcp
description: Connect to a previously-deferred MCP server on demand.
---

`load_mcp` connects to a previously-deferred upstream MCP and makes its tools, resources, and prompts available to the host.

This tool is exposed **only** when [dynamic discovery](/guides/dynamic-discovery/) is enabled — i.e. when at least one entry in the config file declares a `description` field. In all other modes (single-MCP `--` mode, or config-file mode with no `description` fields anywhere), `load_mcp` is not registered.

## Description (static)

`"Load a previously-deferred MCP server so that its tools, resources, and prompts become available. Pass the server name as shown in the <mcp_servers> block of the discover_tool description. Loading is permanent for the remainder of this session."`

## Input

| Field | Type | Description |
|---|---|---|
| `mcp_name` | `string` | The name of an MCP server listed in `<mcp_servers>` (matches the key under `mcp` in the config file). |

## Output

A structured listing of everything the just-loaded MCP now exposes:

| Field | Type | Description |
|---|---|---|
| `mcp_name` | `string` | Echoes the loaded MCP's name. |
| `tools` | `Array<{ name, description }>` | Every tool the MCP exposes. `name` is fully namespaced (e.g. `chrome-devtools/browser_navigate`). Schemas are **not** included — call [`discover_tool`](/reference/tools/discover-tool/) to retrieve them. |
| `resources` | `Array<{ uri, name, description?, mimeType? }>` | Concrete resources (if any). URIs are forwarded verbatim. Empty array if the MCP does not advertise the resources capability. |
| `resource_templates` | `Array<{ uriTemplate, name, description?, mimeType? }>` | Resource templates (if any). Empty array if not advertised. |
| `prompts` | `Array<{ name, description?, arguments? }>` | Prompts (if any). Empty array if the MCP does not advertise the prompts capability. |

## Behavior

| Property | Behavior |
|---|---|
| **Idempotent** | Calling `load_mcp` for a server that is already loaded — either eager or previously loaded lazy — returns the same listing with no side effects. |
| **Permanent** | Loaded servers stay loaded for the lifetime of the `dynmcp` process. There is no `unload_mcp`. |
| **Atomic on failure** | If the upstream fails to connect, initialize, or return its catalog, the partial state is torn down and the lazy entry remains available to retry. |
| **Concurrency** | Concurrent calls for **different** MCPs run in parallel. Concurrent calls for the **same** MCP coalesce — the second call awaits the first and returns the same listing. |
| **Retry budget** | After **three consecutive failed** load attempts for the same MCP, the entry is evicted from `<mcp_servers>` and subsequent calls return "unknown server". |

## Error behavior

| Condition | Behavior |
|---|---|
| `mcp_name` does not match any entry in `mcp` | Error listing the names of all currently-lazy (not-yet-loaded) MCPs. |
| `mcp_name` matches an eager (already-loaded) MCP | **Not an error.** Returns the MCP's current listing. |
| Upstream connection or `initialize` fails | Error returned with the underlying failure reason; the MCP remains lazy and can be retried (subject to the retry budget). |
| Upstream catalog query fails after initialize | Same behavior as connection failure — fully torn down, MCP remains lazy. |

## Example

Calling `load_mcp` with `mcp_name: "chrome-devtools"`:

```json
{
  "mcp_name": "chrome-devtools",
  "tools": [
    { "name": "chrome-devtools/browser_navigate", "description": "Navigate the browser to a URL" },
    { "name": "chrome-devtools/browser_screenshot", "description": "Take a screenshot of the current page" }
  ],
  "resources": [],
  "resource_templates": [],
  "prompts": []
}
```

The agent can now call `discover_tool` with `chrome-devtools/browser_navigate` to retrieve its full schema, then `use_tool` to execute it.
