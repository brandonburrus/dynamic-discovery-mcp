---
title: Quick Start
description: Wrap a single upstream MCP with dynmcp.
---

The fastest way to use `dynmcp` is to prefix any existing MCP invocation with `dynmcp --`. Everything after the `--` is the command that launches the upstream MCP.

## Before

A normal MCP invocation that dumps every tool schema into your host's context:

```bash
npx -y chrome-devtools-mcp@latest
```

The host sees every tool the upstream defines (often dozens) and every schema lands in context.

## With dynmcp

```bash
npx dynmcp@latest -- npx -y chrome-devtools-mcp@latest
```

The host now sees two tools: `discover_tool` and `use_tool`. A full schema enters context only when the agent asks for one through `discover_tool`.

## What the agent sees

`discover_tool`'s description is a compact catalog of every upstream tool, just names and one-line summaries. The agent scans it, calls `discover_tool` to load the full schema of whatever tool it picks, then calls `use_tool` to run it.

In single-MCP mode, tool names are exposed as-is. No namespace prefix. `browser_navigate` is `browser_navigate`, not `chrome-devtools/browser_navigate`.

## Wiring it into an agent host

Any host that can launch an MCP via a command will work. A JSON-style host config looks like:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "dynmcp@latest", "--", "npx", "-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

## Next

- [Single MCP Mode](/guides/single-mcp/) — full details on `--` mode.
- [Config File Mode](/guides/config-file/) — proxy multiple upstream MCPs at once.
- [Dynamic Discovery](/guides/dynamic-discovery/) — defer whole MCPs until the agent asks for them.
- [Scaffold a config from the CLI](/reference/cli/#scaffolding-a-config) — `dynmcp init` + `dynmcp add` build the config file for you instead of hand-authoring JSON.
