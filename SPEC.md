# dynamic-mcp — Project Specification

> **This file is the authoritative blueprint for this project.**
> No feature may be built, changed, or removed without first updating this spec and reaching agreement with the project owner. If it is not in this file, it does not get built.

---

## Problem Statement

Large MCPs (e.g. Chrome DevTools, filesystem tools, browser automation) expose tens to hundreds of tools. When multiple such MCPs are active simultaneously, the entire tool catalog is injected into the LLM context window on every request. This creates two compounding problems:

1. **Cognitive overload** — the agent is presented with tools it will never need for the current task, degrading decision quality and increasing hallucination risk.
2. **Context cost** — every tool schema, regardless of relevance, consumes tokens and drives up inference cost.

The core insight: for any given agent goal, only a small subset of tools is actually relevant. The rest is noise.

---

## Solution

`dynamic-mcp` is a local proxy MCP that sits in front of one or more upstream MCPs running on the same machine. Instead of exposing every upstream tool directly, it exposes exactly two meta-tools:

- **`discover_tool`** — lets the agent find out what a specific tool does and how to call it.
- **`use_tool`** — lets the agent call any tool by name with the appropriate input.

The agent workflow becomes: identify what tools exist at a high level → discover the one(s) relevant to the current goal → use them. The full tool schemas of irrelevant tools never enter the context window.

`dynamic-mcp` runs locally only, communicating with both the agent host and upstream MCPs over stdio.

---

## Package Identity

| Field | Value |
|---|---|
| npm package name | `dynamic-mcp` |
| CLI binary name | `dynamic-mcp` |
| MCP server name | `dynamic-mcp` |
| Repository | `brandonburrus/dynamic-discovery-mcp` |

---

## Tools

### `discover_tool`

Allows the agent to learn the full schema of a single upstream tool before calling it.

**Description (dynamic):** Generated at runtime from the upstream tool catalog. The description opens with a one-line instruction, followed by the full tool catalog wrapped in a `<tools>` XML block. Each MCP is listed as a named group with its tools as a bullet list.

Single MCP (`--` mode) example — no namespace prefix:

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

Config file mode example — namespace prefix always present:

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

Tool names shown in the catalog match exactly what must be passed to `tool_name` in both `discover_tool` and `use_tool`.

**Input:**

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | The name of the upstream tool to look up. Bare name in single-MCP mode (e.g. `browser_navigate`); namespaced in config file mode (e.g. `chrome-devtools/browser_navigate`) |

**Output:** The full tool schema — namespaced name, complete description, and input schema (parameter names, types, descriptions, required flags).

**Error behavior:** If `tool_name` does not match any proxied tool, return a clear error message listing the available namespaced tool names.

---

### `use_tool`

Executes a previously-discovered upstream tool.

**Description (static):** `"Use a tool that was previously discovered with the discover_tool tool."`

**Input:**

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | The name of the upstream tool to call. Bare name in single-MCP mode (e.g. `browser_navigate`); namespaced in config file mode (e.g. `chrome-devtools/browser_navigate`) |
| `tool_input` | `object` | The input payload for that tool, matching its schema |

**Output:** The raw output returned by the upstream tool, passed through without modification.

**Error behavior:**
- If `tool_name` does not exist, return a clear error.
- If `tool_input` does not match the upstream tool's schema, surface the upstream validation error directly to the agent.
- If the upstream tool call fails, propagate the upstream error message.

---

## Tool Name Namespacing

All tool names exposed by `dynamic-mcp` are prefixed with the upstream MCP's configured `name` using a `/` separator:

```
<mcp-name>/<original-tool-name>
```

Examples:
- A tool named `browser_navigate` from an MCP configured as `chrome-devtools` becomes `chrome-devtools/browser_navigate`.
- A tool named `read_file` from an MCP configured as `filesystem` becomes `filesystem/read_file`.

**Single MCP (`--` mode) — no namespace prefix:** When launched with `dynamic-mcp -- <command>`, tool names are exposed as-is without any namespace prefix. There is only one upstream MCP so there is no ambiguity to resolve.

**Config file mode — namespace always required:** When a config file is used, every tool name is prefixed with the MCP's `name` value. This is mandatory because multiple MCPs may expose tools with the same original name.

---

## Config File

### Overview

To proxy multiple upstream MCPs simultaneously, a config file must be provided. The config file declares the set of upstream MCPs to proxy and their connection details as a map keyed by MCP name, under the `mcp` key.

**File names auto-discovered (in order of precedence):**
1. Path provided via `-c` / `--config` CLI flag (explicit, highest priority)
2. `mcp.json` in the current working directory
3. `.mcp.json` in the current working directory

If none of these are found and no `--` command is provided, `dynamic-mcp` exits with a clear error.

### Supported Formats

Both JSON and YAML are supported. Format is determined by file extension:
- `.json` — parsed as JSON
- `.yml` or `.yaml` — parsed as YAML

### Schema

The config file schema is defined and validated with a Zod schema at runtime. The same Zod schema is used to generate a JSON Schema file (published as part of the package) so users can wire up editor validation via a `$schema` field.

Each entry in `mcp` is a map where the key is the MCP name and the value is its connection config, discriminated by the `transport` field. Three transport types are supported.

**Full schema:**

```json
{
  "$schema": "https://unpkg.com/dynamic-mcp/schema/mcp-config.json",
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
    },
    "remote-http-mcp": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    },
    "remote-sse-mcp": {
      "transport": "sse",
      "url": "https://example.com/sse",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    }
  }
}
```

**Map key:**

| Field | Type | Required | Description |
|---|---|---|---|
| `mcp.<key>` | `string` | Yes | The MCP name. Used as the namespace prefix for all its tools. Must match `/^[a-z0-9][a-z0-9-]*$/`. |

**`transport` field (all entries):**

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `"stdio" \| "streamable-http" \| "sse"` | Yes | How `dynamic-mcp` connects to this upstream MCP. |

**`stdio` transport fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | Yes | The executable to spawn. |
| `args` | `string[]` | No | Arguments to pass to the command. Defaults to `[]`. |
| `env` | `Record<string, string>` | No | Environment variables to set for the spawned process. |

**`streamable-http` and `sse` transport fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | The URL of the remote MCP endpoint. Must be a valid URL. |
| `headers` | `Record<string, string>` | No | HTTP headers to include on every request (e.g. for bearer token auth). |

**Validation rules enforced at startup:**
- `stdio` entries must not include `url` or `headers`.
- `streamable-http` and `sse` entries must not include `command`, `args`, or `env`.

### YAML equivalent

```yaml
mcp:
  chrome-devtools:
    transport: stdio
    command: npx
    args: ["-y", "chrome-devtools-mcp@latest"]

  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

  remote-http-mcp:
    transport: streamable-http
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer my-token"

  remote-sse-mcp:
    transport: sse
    url: https://example.com/sse
    headers:
      Authorization: "Bearer my-token"
```

---

## Runtime Behavior

`dynamic-mcp` runs locally only. It communicates with the agent host (e.g. an IDE or agent runner) over stdio. Upstream MCPs are connected to based on their configured transport — spawned as child processes for `stdio`, or connected to over HTTP for `streamable-http` and `sse`.

**Single MCP (`--` command):**

```bash
# Normal upstream MCP invocation
npx -y chrome-devtools-mcp@latest

# Same MCP, proxied through dynamic-mcp
npx -y dynamic-mcp -- chrome-devtools-mcp@latest
```

Everything after `--` is treated as the command to launch the upstream MCP. This mode supports exactly one upstream MCP. To proxy multiple MCPs, use a config file instead.

**Multiple MCPs (config file):**

```bash
# Auto-discover mcp.json or .mcp.json in cwd
npx -y dynamic-mcp

# Explicit config file path
npx -y dynamic-mcp --config ./my-config.json
```

**Startup sequence:**
1. Parse CLI arguments and determine mode (`--` command vs config file).
2. If config file mode, locate and parse the config file, then validate against the Zod schema.
3. Connect to each upstream MCP — spawn as a child process for `stdio` entries, or open an HTTP connection for `streamable-http` and `sse` entries.
4. Query each upstream MCP for its full tool list.
5. Build the `discover_tool` description from the combined, namespaced tool catalog.
6. Start accepting MCP requests from the parent over stdio.

**Shutdown:** When the parent disconnects or the process receives SIGTERM/SIGINT, all spawned child processes are terminated before exit. HTTP connections are closed.

---

## CLI Interface

```
dynamic-mcp [options] [-- <upstream-command> [upstream-args...]]
```

| Flag / Option | Short | Description |
|---|---|---|
| `--version` | `-v` | Print the package version and exit |
| `--help` | `-h` | Print usage information and exit |
| `--config <path>` | `-c` | Path to config file (JSON or YAML) |
| `--` | | Delimiter; everything after is treated as the upstream MCP command (single-MCP mode) |

**Mode resolution:**
1. If `--` is present → single-MCP mode (config file ignored).
2. Otherwise → config file mode (auto-discovered or via `-c`).

---

## Non-Goals (Explicit Exclusions)

The following are explicitly out of scope and must not be built unless this spec is updated:

- Remote / HTTP deployment of `dynamic-mcp` itself.
- Tool filtering, allow-listing, or deny-listing of upstream tools.
- Caching or memoizing upstream tool responses.
- A web UI or dashboard.
- Automatic upstream MCP discovery (e.g. scanning a config directory).
- Resource proxying (MCP resources are out of scope; tools only).
- Prompt proxying (MCP prompts are out of scope; tools only).
- Environment variable substitution in config file values.

---

## Revision History

| Date | Change |
|---|---|
| 2026-05-18 | Initial spec drafted |
| 2026-05-18 | Resolved: multi-MCP syntax (config file), tool name collisions (namespace prefix), config file format (JSON + YAML), `discover_tool` description format (`<tools>` XML block) |
| 2026-05-18 | Added `streamable-http` and `sse` transport support to config file schema for connecting to remote upstream MCPs |
