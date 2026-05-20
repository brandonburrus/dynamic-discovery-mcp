# Dynamic Discovery MCP

A proxy MCP that exposes meta-tools so agents can discover and call upstream MCP tools on demand, without loading every tool schema into the context window.

**Full documentation:** [dynamicmcp.tools](https://dynamicmcp.tools)

## Features

- **Two meta-tools instead of N.** Wraps one or more upstream MCPs and exposes only `discover_tool` and `use_tool` to the agent. Full schemas of irrelevant tools never enter context.
- **Dynamic discovery of whole MCPs.** Mark MCPs with a `description` in your config and they stay disconnected until the agent calls `load_mcp` — deferring entire MCP catalogs out of context until they are actually needed.
- **Full-fidelity proxying.** Resources, prompts, completion, logging, notifications, cancellation, progress, and server-initiated requests (sampling, elicitation, roots) pass through unchanged.
- **Multiple transports for upstreams.** `stdio` child processes, `streamable-http`, and `sse` — all in one config.
- **JSON or YAML config** with shell-style `${VAR}` and `${VAR:-default}` environment variable interpolation.
- **Local-only.** Single Node.js process speaking MCP over stdio. No daemon, no remote endpoint.

## Getting Started

### Wrap a single upstream MCP

```bash
# Before — tool schemas go straight into context
npx -y chrome-devtools-mcp@latest

# With dynmcp — only discover_tool and use_tool are exposed
npx dynmcp@latest -- npx -y chrome-devtools-mcp@latest
```

Everything after `--` is the command used to launch the upstream MCP. In this mode tool names are exposed as-is (no namespace prefix).

### Proxy multiple MCPs from a config file

Create a `mcp.json` in your project root:

```json
{
  "$schema": "https://dynamicmcp.tools/config.json",
  "mcp": {
    "chrome-devtools": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

Then run:

```bash
# Auto-discover mcp.json or .mcp.json
npx dynmcp@latest

# Or specify explicitly
npx dynmcp@latest --config ./my-config.json
```

In config-file mode tool names are namespaced as `<mcp-name>/<tool-name>` to avoid collisions.

## Dynamic Discovery

For configs with heavier MCPs you only sometimes need (Chrome DevTools, remote APIs, anything expensive to keep open), give the entry a `description`. That MCP becomes *lazy*: `dynmcp` doesn't open the connection at startup, and the agent only sees a short summary of what the MCP does. When the agent decides it actually needs that MCP, it calls `load_mcp` with the server's name and the connection opens on demand.

```json
{
  "$schema": "https://dynamicmcp.tools/config.json",
  "mcp": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "chrome-devtools": {
      "description": "Chrome browser automation and DevTools control. Navigate pages, take screenshots, inspect the DOM, run JavaScript. Use when you need to interact with or debug a live web page.",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

`filesystem` connects at startup. `chrome-devtools` stays lazy until the agent loads it. Once loaded, it behaves exactly like an eager MCP for the rest of the session.

See the [Dynamic Discovery guide](https://dynamicmcp.tools/guides/dynamic-discovery/) for the capability caveat, the retry budget, and tips on writing descriptions agents can act on.

---

Full [docs](https://dynamicmcp.tools) cover environment variable interpolation, all transport options, and the complete CLI reference.

