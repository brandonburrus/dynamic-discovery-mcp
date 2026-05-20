---
title: discover_tool
description: Look up the full schema of a single upstream tool before calling it.
---

`discover_tool` is how the agent looks up the full schema of an upstream tool before calling it with [`use_tool`](/reference/tools/use-tool/).

## Description (dynamic)

The description shown to the host is generated at runtime from the upstream tool catalog. It opens with a one-line instruction and follows with the full catalog wrapped in a `<tools>` XML block. Each MCP is a named group with its tools as a bullet list.

When [dynamic discovery](/guides/dynamic-discovery/) is on, the description also includes a `<mcp_servers>` block listing every upstream MCP that hasn't been loaded yet, along with the description you wrote for each.

### Single MCP mode

No namespace prefix on tool names:

```
Use this tool to look up the full schema of a tool before calling it with use_tool.
Call discover_tool with a tool name from the list below to get its complete description,
input parameters, and output schema. Always discover a tool before using it.

<tools>
- browser_navigate: Navigate the browser to a URL
- browser_screenshot: Take a screenshot of the current page
- browser_click: Click an element on the page
</tools>
```

### Config file mode

Tools are grouped under their MCP name. To call a tool, combine the group header with the bullet — `chrome-devtools` + `browser_navigate` → `chrome-devtools/browser_navigate`.

```
Use this tool to look up the full schema of a tool before calling it with use_tool.
Call discover_tool with a tool name from the list below to get its complete description,
input parameters, and output schema. Always discover a tool before using it.

<tools>
chrome-devtools:
- browser_navigate: Navigate the browser to a URL
- browser_screenshot: Take a screenshot of the current page
- browser_click: Click an element on the page

filesystem:
- read_file: Read the contents of a file
- write_file: Write content to a file
</tools>
```

### Dynamic discovery mode

`<mcp_servers>` shows MCPs that haven't been loaded yet. `<tools>` shows only what's currently loaded (eager MCPs and any lazy MCPs the agent has already loaded).

```
Use this tool to look up the full schema of a tool before calling it with use_tool.
Call discover_tool with a tool name from the list below to get its complete description,
input parameters, and output schema. Always discover a tool before using it.

Some MCP servers below are not loaded yet and are listed under <mcp_servers> with a
short description of what they do. To make a server's tools (and any resources or
prompts it exposes) available, call load_mcp with its name. Once loaded, the server's
tools will appear in the <tools> list and become callable via use_tool. Loading is
permanent for the remainder of this session.

<mcp_servers>
- chrome-devtools: Browser automation via Chrome DevTools Protocol. Navigate pages,
  take screenshots, inspect the DOM, run JavaScript in page context, capture network
  traffic. Use when you need to interact with a live web page.
- jira: Read and write Jira issues, comments, transitions, and sprint state. Use when
  the task involves tracking work or referencing tickets.
</mcp_servers>

<tools>
filesystem:
- read_file: Read the contents of a file
- write_file: Write content to a file
</tools>
```

If dynamic discovery is on and nothing is loaded yet (no eager MCPs, no successful `load_mcp` calls), the `<tools>` block is dropped and a closing line tells the agent that no tools are currently loaded.

## Input

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | The name of the upstream tool to look up. Bare name in single-MCP mode (e.g. `browser_navigate`); namespaced in config file mode (e.g. `chrome-devtools/browser_navigate`). |

## Output

The full tool schema:

- Tool name as exposed in the current mode (bare in single-MCP mode, namespaced in config-file mode).
- Complete description.
- Input schema: parameter names, types, descriptions, required flags.

## Errors

If `tool_name` doesn't match any proxied tool, `discover_tool` returns a clear error listing the names that are available.
