# dynamic-discovery-mcp — Project Specification

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

`dynamic-discovery-mcp` is a local proxy MCP that sits in front of one or more upstream MCPs running on the same machine. Instead of exposing every upstream tool directly, it exposes exactly two meta-tools:

- **`discover_tool`** — lets the agent find out what a specific tool does and how to call it.
- **`use_tool`** — lets the agent call any tool by name with the appropriate input.

The agent workflow becomes: identify what tools exist at a high level → discover the one(s) relevant to the current goal → use them. The full tool schemas of irrelevant tools never enter the context window.

Beyond the discovery pattern applied to tools, `dynmcp` is a **full-fidelity proxy** for the rest of the MCP protocol surface: resources, prompts, completion, logging, notifications, cancellation, progress reporting, and server-initiated requests (sampling, elicitation, roots) are all passed through. The goal is that an agent host talking to `dynmcp` perceives no loss of protocol semantics versus talking directly to each upstream — only the tool catalog is reshaped into the discovery pattern. See [Proxy Behavior](#proxy-behavior) for the full pass-through specification.

`dynamic-discovery-mcp` runs locally only, communicating with both the agent host and upstream MCPs over stdio.

---

## Package Identity

| Field | Value |
|---|---|
| npm package name | `dynmcp` |
| CLI binary name | `dynmcp` |
| MCP server name | `dynamic-discovery-mcp` |
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

All tool names exposed by `dynamic-discovery-mcp` are prefixed with the upstream MCP's configured `name` using a `/` separator:

```
<mcp-name>/<original-tool-name>
```

Examples:
- A tool named `browser_navigate` from an MCP configured as `chrome-devtools` becomes `chrome-devtools/browser_navigate`.
- A tool named `read_file` from an MCP configured as `filesystem` becomes `filesystem/read_file`.

**Single MCP (`--` mode) — no namespace prefix:** When launched with `dynmcp -- <command>`, tool names are exposed as-is without any namespace prefix. There is only one upstream MCP so there is no ambiguity to resolve.

**Config file mode — namespace always required:** When a config file is used, every tool name is prefixed with the MCP's `name` value. This is mandatory because multiple MCPs may expose tools with the same original name.

**Scope of namespacing:** Namespacing applies **only to tool names**. Resource URIs, prompt names, and other identifiers are forwarded verbatim from upstream — see [Proxy Behavior](#proxy-behavior).

---

## Proxy Behavior

### Overview

For every MCP protocol feature other than tools, `dynmcp` is a transparent, full-fidelity proxy. The agent host perceives the union of every upstream MCP's resources, prompts, completion, logging, and server-initiated request flows as a single composite MCP. This section specifies routing, aggregation, identifier handling, and lifecycle rules for that pass-through behavior.

### Capability Aggregation

During `initialize`, the proxy advertises a capability to the host iff at least one connected upstream advertises it.

| Capability | Rule |
|---|---|
| `tools` | Always advertised (proxy always exposes `discover_tool` and `use_tool`). |
| `tools.listChanged` | Always advertised. The proxy emits this notification whenever any upstream's tool list changes, so that the host refetches and re-reads the regenerated `discover_tool` description. |
| `resources` | Advertised iff any upstream advertises it. |
| `resources.subscribe` | Advertised iff any upstream advertises it. |
| `resources.listChanged` | Advertised iff any upstream advertises it. |
| `prompts` | Advertised iff any upstream advertises it. |
| `prompts.listChanged` | Advertised iff any upstream advertises it. |
| `logging` | Advertised iff any upstream advertises it. |
| `completions` | Advertised iff any upstream advertises it. |

The proxy negotiates protocol version with the host independently from each upstream. If an upstream supports an older protocol version than the host negotiated, the proxy serves the host at the host's version and limits behavior toward that one upstream to features that upstream supports.

### Resources

The proxy passes through `resources/list`, `resources/read`, `resources/templates/list`, `resources/subscribe`, and `resources/unsubscribe`.

- **`resources/list`** aggregates entries from every upstream advertising the resources capability. Entries are concatenated in config-file order. URIs are forwarded **verbatim** with no namespacing applied.
- **`resources/templates/list`** aggregates the same way.
- **`resources/read`** is routed by URI. The proxy maintains a URI → upstream ownership map populated from upstream `resources/list` and `resources/templates/list` results. If two upstreams advertise the same URI, the upstream appearing **first** in config-file order owns it; the shadowed upstream's copy of that resource is unreachable through the proxy. A warning is logged when a collision is detected.
- **`resources/subscribe`** / **`resources/unsubscribe`** are routed to the owning upstream. The proxy maintains one upstream subscription per host subscription; all subscription state is dropped when the host disconnects.
- **`notifications/resources/updated`** from an upstream is forwarded to the host verbatim.
- **`notifications/resources/list_changed`** from an upstream causes the proxy to re-fetch that upstream's resource and template lists, refresh the URI ownership map (re-applying the first-wins rule), and emit `notifications/resources/list_changed` to the host.

In single-MCP (`--`) mode there is one upstream, so collision resolution is moot.

### Prompts

The proxy passes through `prompts/list` and `prompts/get`.

- **`prompts/list`** aggregates entries from every upstream advertising the prompts capability in config-file order. Prompt names are forwarded **verbatim** with no namespacing.
- **`prompts/get`** is routed by prompt name. On name collision, the upstream appearing first in config-file order owns the name; a warning is logged.
- **`notifications/prompts/list_changed`** from an upstream causes the proxy to refresh the prompt-name ownership map and forward the notification to the host.

### Completion

The proxy passes through `completion/complete`. The request's `ref` field is a discriminated union:

- `ref.type === "ref/prompt"` — route to the upstream owning that prompt name.
- `ref.type === "ref/resource"` — route to the upstream owning that resource URI (or template URI).

### Logging

- **`logging/setLevel`** (host → proxy) is broadcast to every upstream advertising the logging capability. The proxy enforces a single global log level across upstreams; per-upstream log levels are not supported.
- **`notifications/message`** (upstream → proxy) is forwarded to the host with the `logger` field rewritten:
  - In single-MCP (`--`) mode: forwarded verbatim.
  - In config file mode: the `logger` field is prefixed with `<mcp-name>/`. If `logger` was absent, it is set to `<mcp-name>`. This rewriting is informational — logger names are free-form descriptive labels, not protocol identifiers — and serves to let the host attribute log lines to their originating upstream.

### Cancellation

The proxy maintains a bidirectional request-ID translation table:

- **Forward direction**: host request ID ↔ proxy-assigned upstream request ID (for `use_tool`, `resources/read`, `prompts/get`, `completion/complete`, etc.).
- **Reverse direction**: upstream request ID ↔ proxy-assigned host request ID (for server-initiated requests — see below).

`notifications/cancelled` arriving from either side is translated to the matching ID on the opposite side and forwarded.

- If `cancelled` arrives after the underlying request has already completed, it is dropped silently (consistent with the MCP spec).
- If a response arrives from one side after that request was cancelled, the response is dropped and not forwarded.
- If an upstream connection drops while requests are in flight against it, the proxy synthesizes `notifications/cancelled` to the host for each affected request and clears its state.

### Progress

`progressToken` values inside the `_meta` field of forward-direction requests are passed through to the upstream unchanged. `notifications/progress` from upstreams are forwarded to the host without modification. The proxy does not mint or rewrite progress tokens.

### Server-Initiated Requests

The proxy forwards the following upstream → host requests, using reverse-direction request-ID mapping:

- `sampling/createMessage`
- `elicitation/create`
- `roots/list`

For each, the proxy assigns a fresh host-side request ID, forwards the request body verbatim, awaits the host's response, and routes the response back to the originating upstream under that upstream's original request ID. If the host returns an error (including capability-not-supported), the error is forwarded unmodified to the originating upstream.

If the originating upstream disconnects while a server-initiated request is pending against the host, the in-flight host request is left to complete normally and its response is discarded.

**`notifications/roots/list_changed`** from the host is broadcast to every upstream that advertised the `roots` capability.

### Ping

`ping` requests are answered locally by the proxy on both sides — pings from the host are answered by the proxy directly without round-tripping to upstreams, and pings from upstreams are answered by the proxy directly without involving the host. The proxy may independently issue pings to upstreams as a liveness probe; this is an implementation detail and not part of the host-facing contract.

### Request ID Hygiene

JSON-RPC request IDs are scoped to a single transport pair. The proxy never lets an upstream-scoped ID surface on the host transport or vice versa: every cross-boundary request is assigned a fresh, locally-scoped ID, and the translation tables described above are the only state needed to maintain correctness across cancellation, response routing, and connection loss.

---

## Config File

### Overview

To proxy multiple upstream MCPs simultaneously, a config file must be provided. The config file declares the set of upstream MCPs to proxy and their connection details as a map keyed by MCP name, under the `mcp` key.

**File names auto-discovered (in order of precedence):**
1. Path provided via `-c` / `--config` CLI flag (explicit, highest priority)
2. `mcp.json` in the current working directory
3. `.mcp.json` in the current working directory

If none of these are found and no `--` command is provided, `dynmcp` exits with a clear error.

### Supported Formats

Both JSON and YAML are supported. Format is determined by file extension:
- `.json` — parsed as JSON
- `.yml` or `.yaml` — parsed as YAML

### Schema

The config file schema is defined and validated with a Zod schema at runtime. The same Zod schema is used to generate a JSON Schema file (published as part of the package) so users can wire up editor validation via a `$schema` field.

Each entry in `mcp` is a map where the key is the MCP name and the value is its connection config, discriminated by the `transport` field. Three transport types are supported.

**Top-level fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `$schema` | `string` | No | Pointer to the published JSON Schema for editor validation. Not interpreted at runtime. |
| `env` | `"enable" \| "dotenv" \| "process" \| "disable"` | No | Controls environment variable interpolation in config values. Defaults to `"enable"`. See [Environment Variable Interpolation](#environment-variable-interpolation). |
| `mcp` | `Record<string, McpEntry>` | Yes | Map of upstream MCPs, keyed by name. |

**Full schema:**

```json
{
  "$schema": "https://unpkg.com/dynmcp/schema/mcp-config.json",
  "env": "enable",
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

**Top-level fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `mcp` | `Record<string, McpEntry>` | Yes | Map of upstream MCPs to proxy. |
| `env` | `"enable" \| "dotenv" \| "process" \| "disable"` | No | Controls environment variable interpolation. Defaults to `"enable"`. See [Environment Variable Interpolation](#environment-variable-interpolation). |

**Map key:**

| Field | Type | Required | Description |
|---|---|---|---|
| `mcp.<key>` | `string` | Yes | The MCP name. Used as the namespace prefix for all its tools. Must match `/^[a-z0-9][a-z0-9-]*$/`. |

**`transport` field (all entries):**

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `"stdio" \| "streamable-http" \| "sse"` | Yes | How `dynamic-discovery-mcp` connects to this upstream MCP. |

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
env: enable
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

## Environment Variable Interpolation

### Overview

Config file values may reference environment variables using `${VAR}` syntax. Interpolation runs **after** the config file is parsed but **before** Zod validation, so the validated config contains only fully-resolved string values.

This lets users keep secrets (API tokens, paths, credentials) out of the config file and out of version control.

### Syntax

| Form | Meaning |
|---|---|
| `${VAR}` | Substitute the value of `VAR`. If `VAR` is undefined, startup fails. |
| `${VAR:-default}` | Substitute the value of `VAR`, or the literal `default` if `VAR` is undefined or empty. The default may contain any characters, including spaces and colons (e.g. `${URL:-http://localhost:8080}`). |
| `$${...}` | Escape sequence. Resolves to the literal `${...}` with the leading `$` stripped. |

Bare `$VAR` references are **not** supported — only the `${...}` brace form is recognized.

### Scope

Interpolation applies only to **leaf string values** in the config — i.e. wherever the schema expects a `string`. Specifically:

- `stdio.command`
- Each element of `stdio.args`
- Each value in `stdio.env`
- `streamable-http.url`, `sse.url`
- Each value in `streamable-http.headers`, `sse.headers`

Interpolation does **not** apply to:

- Map keys (MCP names under `mcp`, env var names under `stdio.env`, header names under `headers`)
- The top-level `$schema` field
- The top-level `env` field

Both **whole-string** (`"${TOKEN}"`) and **partial** (`"Bearer ${TOKEN}"`) interpolation are supported.

### Environment Variable Sources

Controlled by the top-level `env` field. Default: `"enable"`.

| Value | Behavior |
|---|---|
| `"enable"` | Load `.env` file (if present) **and** read `process.env`. When the same variable is defined in both, the `.env` file wins. |
| `"dotenv"` | Load `.env` file only. `process.env` is ignored entirely. |
| `"process"` | Use `process.env` only. No `.env` file is loaded. |
| `"disable"` | Interpolation is turned off. `${VAR}` is preserved as a literal string in config values; the escape form `$${...}` has no effect. |

### `.env` File Discovery

By default, the `.env` file is looked up in the **current working directory** with the literal filename `.env`. Only a single file is supported — multi-environment patterns like `.env.local` or `.env.production` are out of scope.

A custom path may be specified via the `--env` / `-e` CLI flag. When this flag is provided:

- The file at the given path **must exist**; a missing file causes a startup error.
- The flag is incoherent with `env: "process"` or `env: "disable"`; the combination causes a startup error.

When `env` is `"enable"` or `"dotenv"` and no `--env` flag is given, a missing `.env` file in cwd is **not** an error — interpolation simply proceeds with whatever sources remain (process.env for `"enable"`, nothing for `"dotenv"`).

### Errors

All interpolation errors surface at startup, before any upstream MCP is connected. The following are fatal:

- A `${VAR}` reference with no default value, where `VAR` is not defined in any active source. All missing variables are collected and reported together in a single error message — not one at a time.
- `--env` combined with `env: "disable"` or `env: "process"`.
- `--env <path>` where the path does not exist or is not readable.
- A `.env` file that cannot be parsed; the underlying parse error is surfaced.

---

## Runtime Behavior

`dynmcp` runs locally only. It communicates with the agent host (e.g. an IDE or agent runner) over stdio. Upstream MCPs are connected to based on their configured transport — spawned as child processes for `stdio`, or connected to over HTTP for `streamable-http` and `sse`.

**Single MCP (`--` command):**

```bash
# Normal upstream MCP invocation
npx -y chrome-devtools-mcp@latest

# Same MCP, proxied through dynmcp
npx -y dynmcp -- chrome-devtools-mcp@latest
```

Everything after `--` is treated as the command to launch the upstream MCP. This mode supports exactly one upstream MCP. To proxy multiple MCPs, use a config file instead.

**Multiple MCPs (config file):**

```bash
# Auto-discover mcp.json or .mcp.json in cwd
npx -y dynmcp

# Explicit config file path
npx -y dynmcp --config ./my-config.json
```

**Startup sequence:**
1. Parse CLI arguments and determine mode (`--` command vs config file).
2. If config file mode, locate and parse the config file, then validate against the Zod schema.
3. Connect to each upstream MCP — spawn as a child process for `stdio` entries, or open an HTTP connection for `streamable-http` and `sse` entries. Negotiate `initialize` with each upstream and record its declared capabilities.
4. Query each upstream MCP for its full tool list, and (for capability-advertising upstreams) prompts, resource templates, and initial resource list. Detect resource-URI and prompt-name collisions and log warnings.
5. Build the `discover_tool` description from the combined, namespaced tool catalog. Build the aggregated capability set for the host-facing `initialize` response.
6. Start accepting MCP requests from the parent over stdio.

**Shutdown:** When the parent disconnects or the process receives SIGTERM/SIGINT, all spawned child processes are terminated before exit. HTTP connections are closed. Any in-flight server-initiated requests against the host are abandoned without forwarding their responses.

---

## CLI Interface

```
dynmcp [options] [-- <upstream-command> [upstream-args...]]
```

| Flag / Option | Short | Description |
|---|---|---|
| `--version` | `-v` | Print the package version and exit |
| `--help` | `-h` | Print usage information and exit |
| `--config <path>` | `-c` | Path to config file (JSON or YAML) |
| `--env <path>` | `-e` | Path to a custom `.env` file for environment variable interpolation. See [Environment Variable Interpolation](#environment-variable-interpolation). |
| `--` | | Delimiter; everything after is treated as the upstream MCP command (single-MCP mode) |

**Mode resolution:**
1. If `--` is present → single-MCP mode (config file ignored).
2. Otherwise → config file mode (auto-discovered or via `-c`).

---

## Non-Goals (Explicit Exclusions)

The following are explicitly out of scope and must not be built unless this spec is updated:

- Remote / HTTP deployment of `dynmcp` itself.
- Tool filtering, allow-listing, or deny-listing of upstream tools.
- Caching or memoizing upstream tool responses.
- A web UI or dashboard.
- Automatic upstream MCP discovery (e.g. scanning a config directory).
- Discovery-pattern abstraction over resources or prompts. These are passed through natively per [Proxy Behavior](#proxy-behavior); they are not hidden behind meta-tools the way `tools/call` is hidden behind `use_tool`.
- Per-upstream log level control. `logging/setLevel` is broadcast to all upstreams; selective routing is not supported.

---

## Revision History

| Date | Change |
|---|---|
| 2026-05-18 | Initial spec drafted |
| 2026-05-18 | Resolved: multi-MCP syntax (config file), tool name collisions (namespace prefix), config file format (JSON + YAML), `discover_tool` description format (`<tools>` XML block) |
| 2026-05-18 | Added `streamable-http` and `sse` transport support to config file schema for connecting to remote upstream MCPs |
| 2026-05-18 | Added environment variable interpolation in config file leaf string values (`${VAR}` and `${VAR:-default}` syntax, `$${...}` escape). New top-level `env` field (`"enable"` default, `"dotenv"`, `"process"`, `"disable"`). New `--env` / `-e` CLI flag for custom `.env` path. Removed corresponding non-goal. |
| 2026-05-18 | Added full-fidelity upstream proxying for resources, prompts, completion, logging, notifications, cancellation, progress, and server-initiated requests (`sampling/createMessage`, `elicitation/create`, `roots/list`). New "Proxy Behavior" section. Resource URIs and prompt names pass through verbatim with first-config-wins collision resolution; tool names remain namespaced. Removed corresponding non-goals. |
