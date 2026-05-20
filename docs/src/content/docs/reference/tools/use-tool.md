---
title: use_tool
description: Execute a previously-discovered upstream tool.
---

`use_tool` executes a tool by name, proxying the call to the owning upstream MCP and returning its output unchanged.

## Description (static)

`"Use a tool that was previously discovered with the discover_tool tool."`

This description is fixed and does not change at runtime, unlike [`discover_tool`'s](/reference/tools/discover-tool/) dynamic description.

## Input

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | The name of the upstream tool to call. Bare name in single-MCP mode (e.g. `browser_navigate`); namespaced in config file mode (e.g. `chrome-devtools/browser_navigate`). |
| `tool_input` | `object` | The input payload for that tool, matching its schema. |

The expected shape of `tool_input` is whatever the upstream tool's input schema declares — call [`discover_tool`](/reference/tools/discover-tool/) first to retrieve it.

## Output

The **raw output** returned by the upstream tool, passed through without modification.

## Routing

`use_tool` is the only host-facing tool-execution surface. It routes by `tool_name`:

- In **single-MCP mode**, there is one upstream, so routing is trivial.
- In **config file mode**, the namespace prefix (`<mcp-name>/`) identifies the owning upstream. The rest of the name is forwarded to that upstream verbatim.

## Errors

| Condition | Behavior |
|---|---|
| `tool_name` does not exist (typo, or upstream not loaded) | Returns a clear error. |
| `tool_input` does not match the upstream tool's schema | The upstream's validation error is surfaced directly to the agent. |
| The upstream tool itself fails | The upstream error message is propagated unchanged. |
