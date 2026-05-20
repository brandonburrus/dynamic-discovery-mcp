---
title: Single MCP Mode
description: Wrap one upstream MCP using the -- command.
---

Single MCP mode is the simplest way to use `dynmcp`. Whatever comes after `--` is the command that launches the upstream. No config file needed.

```bash
dynmcp -- <upstream-command> [upstream-args...]
```

## Examples

`chrome-devtools-mcp`:

```bash
npx dynmcp@latest -- npx -y chrome-devtools-mcp@latest
```

The official filesystem MCP, scoped to `/tmp`:

```bash
npx dynmcp@latest -- npx -y @modelcontextprotocol/server-filesystem /tmp
```

A binary already on your `PATH`:

```bash
npx dynmcp@latest -- my-mcp-binary --some-flag value
```

## No namespace prefix

With only one upstream, there's nothing to disambiguate. Tool names pass through to the host verbatim:

- `browser_navigate` is still `browser_navigate`.
- `read_file` is still `read_file`.

Any existing prompts or instructions that reference upstream tools by name keep working.

## What still works

Single MCP mode still proxies the full MCP protocol — resources, prompts, completion, logging, notifications, cancellation, progress, and server-initiated requests. The tool catalog is the only thing it reshapes, behind `discover_tool` / `use_tool`.

## What doesn't work

- `load_mcp` isn't registered. There's no config file in which to declare a lazy MCP. See [Dynamic Discovery](/guides/dynamic-discovery/).
- The `--config` / `-c` flag is ignored when `--` is present (see [Mode Resolution](/reference/cli/#mode-resolution)).

## When to reach for it

- You want to try `dynmcp` against an MCP you already use.
- You're only proxying one MCP and don't want a config file in the repo.

Need to proxy more than one? Move to [Config File Mode](/guides/config-file/).
