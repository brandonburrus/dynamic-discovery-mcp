---
title: Dynamic Discovery
description: Defer whole MCP servers until the agent decides it needs them.
---

The `discover_tool` / `use_tool` pattern keeps individual tool schemas out of context until the agent asks for one. Dynamic discovery does the same thing for whole MCP servers.

It's worth turning on when you have an MCP that's expensive to keep alive but only sometimes needed: a Chrome DevTools instance that has to spawn a real browser, a remote API that costs money on idle connections, a third-party server you'd rather not connect to unless you have to. Mark it lazy and `dynmcp` won't open the connection until the agent actually wants the MCP.

## Turning it on

Add a `description` field to any MCP entry in your config. That MCP is now lazy. Its connection is deferred and it shows up in a `<mcp_servers>` block in `discover_tool`'s description, instead of contributing its tools to `<tools>`.

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
      "description": "Chrome browser automation and DevTools control. Navigate pages, take screenshots, inspect the DOM, run JavaScript, record performance traces, analyze network requests, read console messages. Use for any task that needs to interact with or debug a live web page.",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "aws-knowledge": {
      "description": "AWS documentation, code samples, and best-practice guidance. Search and read AWS docs, API references, blog posts, CDK/CloudFormation templates, and regional availability info. Use when the task involves AWS services or infrastructure-as-code.",
      "transport": "streamable-http",
      "url": "https://knowledge-mcp.global.api.aws"
    }
  }
}
```

Here, `filesystem` connects at startup (eager). `chrome-devtools` and `aws-knowledge` stay lazy. No child process is spawned, no HTTP connection is opened, until the agent calls `load_mcp` with the corresponding name.

## What changes when it's on

A `description` on any entry flips the whole proxy into dynamic-discovery mode. From that point:

- A third meta-tool, `load_mcp`, is registered and exposed to the host.
- `discover_tool`'s description gains a `<mcp_servers>` section listing every lazy MCP along with its description.
- `<tools>` starts off showing only the eager MCPs' tools. Each successful `load_mcp` call promotes the loaded server into `<tools>`.
- If there are no eager MCPs and nothing has been loaded yet, `<tools>` is dropped and a trailing sentence tells the agent that no tools are currently loaded.

## How the agent uses it

The agent reads the `<mcp_servers>` block and decides whether any of the lazy MCPs are relevant to the current task. If one is, it calls `load_mcp` with the server name. The proxy opens the transport, runs `initialize`, queries the server's catalogs, and merges everything into the live state. The agent now sees that server's tools in `<tools>` and can call `discover_tool` / `use_tool` against them like any eager MCP.

## `load_mcp` semantics

| Property | Behavior |
|---|---|
| **Idempotent** | Calling `load_mcp` on a server that's already loaded (or on an eager server) is a no-op that returns the current listing. |
| **Permanent** | Once loaded, a server stays loaded for the rest of the `dynmcp` process. There's no `unload_mcp`. |
| **Atomic on failure** | If the upstream fails to connect, initialize, or return its catalog, any partial state is torn down and the lazy entry stays in `<mcp_servers>` for next time. |
| **Concurrency** | Concurrent calls for the same name coalesce onto one connection attempt. Calls for different names run in parallel. |
| **Retry budget** | After three consecutive failed `load_mcp` attempts on the same name, the entry is evicted from `<mcp_servers>` and later calls get back "unknown server". |

The [`load_mcp` reference](/reference/tools/load-mcp/) has the full input/output schema and error behavior.

## The capability caveat

This is the one wrinkle worth knowing about. The MCP protocol negotiates capabilities once, when your host connects to `dynmcp`. Lazy upstreams aren't connected at that point, so they can't expand the capability set the host has already negotiated.

Tools always work. The `tools` capability is advertised unconditionally, so `load_mcp` → `use_tool` is reliable for any lazy MCP regardless of what your eager MCPs declared.

Resources, prompts, logging, and completion are the wrinkle. If a lazy MCP exposes one of these, `dynmcp` will still merge it into the routers on load and emit the appropriate `*/list_changed` notification. But if no eager MCP also advertised that same capability at startup, a strict host won't be listening for it and may ignore the notification.

If you want a lazy MCP's resources or prompts to reach the host reliably, do one of two things: keep that MCP eager (drop the `description`), or include at least one other eager MCP that advertises the same capability so the host has subscribed to listen.

## When not to bother

Lazy loading is the wrong call in two situations.

If the MCP is cheap to start (a tiny stdio process) and you're going to need it on most tasks anyway, the lazy round-trip isn't saving you much. Keep it eager.

If the main thing you want from the MCP is its resources or prompts and no other eager MCP advertises that capability, the capability caveat will bite. Either keep it eager or pull in a placeholder eager MCP that advertises the matching capability.

## Next steps

- [Writing Good Descriptions](/guides/writing-descriptions/) — the description is what the agent reads to decide whether to load a server. It's worth getting right.
- [`load_mcp` reference](/reference/tools/load-mcp/) — full tool signature and error model.
