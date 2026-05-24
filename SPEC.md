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

The same principle is extended one level up via **dynamic discovery**: when an upstream MCP in the config file declares a human-readable `description`, that MCP is treated as *lazy* — its connection is deferred and its tools, resources, and prompts are kept out of the host-facing catalog until the agent explicitly opts in by calling **`load_mcp`** with the server's name. The `<mcp_servers>` listing of available-but-not-loaded servers and their descriptions takes the place of their tool entries in the `discover_tool` description, letting the agent reason about which whole MCPs are worth pulling in for the current task without seeing any tools from servers it does not need. See [Dynamic Discovery](#dynamic-discovery) for the full lifecycle and behavior specification.

Beyond the discovery pattern applied to tools and (optionally) to whole servers, `dynmcp` is a **full-fidelity proxy** for the rest of the MCP protocol surface: resources, prompts, completion, logging, notifications, cancellation, progress reporting, and server-initiated requests (sampling, elicitation, roots) are all passed through. The goal is that an agent host talking to `dynmcp` perceives no loss of protocol semantics versus talking directly to each upstream — only the tool catalog (and, in dynamic-discovery mode, the per-server catalogs) is reshaped into the discovery pattern. See [Proxy Behavior](#proxy-behavior) for the full pass-through specification.

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

When [dynamic discovery](#dynamic-discovery) is enabled, the description additionally includes a `<mcp_servers>` XML block listing every upstream MCP that has not yet been loaded, along with its declared description and an explanatory paragraph telling the agent to use `load_mcp` to make a server's tools available. Tools from not-yet-loaded MCPs do **not** appear in `<tools>` — they appear there only once their MCP has been loaded.

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

Dynamic-discovery mode example — `<mcp_servers>` lists not-yet-loaded MCPs; `<tools>` lists only what is currently loaded (eager MCPs and previously loaded lazy MCPs):

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

If dynamic discovery is enabled and no eager or loaded MCPs are present, the `<tools>` block is omitted and a trailing sentence informs the agent that no tools are currently loaded.

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

### `load_mcp`

Connects to a previously-deferred upstream MCP and makes its tools, resources, and prompts available to the host. Exposed **only** when [dynamic discovery](#dynamic-discovery) is enabled — i.e. when at least one entry in the config file declares a `description` field. In all other modes (single-MCP `--` mode, or config-file mode with no `description` fields anywhere), this tool is not registered.

**Description (static):** `"Load a previously-deferred MCP server so that its tools, resources, and prompts become available. Pass the server name as shown in the <mcp_servers> block of the discover_tool description. Loading is permanent for the remainder of this session."`

**Input:**

| Field | Type | Description |
|---|---|---|
| `mcp_name` | `string` | The name of an MCP server listed in `<mcp_servers>` (matches the key under `mcp` in the config file). |

**Output:** A structured listing of everything the just-loaded MCP now exposes:

| Field | Type | Description |
|---|---|---|
| `mcp_name` | `string` | Echoes the loaded MCP's name. |
| `tools` | `Array<{ name, description }>` | Every tool the MCP exposes. `name` is fully namespaced (e.g. `chrome-devtools/browser_navigate`). Schemas are **not** included here — call `discover_tool` to retrieve them. |
| `resources` | `Array<{ uri, name, description?, mimeType? }>` | Concrete resources (if any). URIs are forwarded verbatim. Empty array if the MCP does not advertise the resources capability. |
| `resource_templates` | `Array<{ uriTemplate, name, description?, mimeType? }>` | Resource templates (if any). Empty array if not advertised. |
| `prompts` | `Array<{ name, description?, arguments? }>` | Prompts (if any). Empty array if the MCP does not advertise the prompts capability. |

**Side effects emitted as part of a successful load (in this order):**
1. `notifications/tools/list_changed` — always, since `discover_tool`'s description has changed (the MCP moves from `<mcp_servers>` into `<tools>`).
2. `notifications/resources/list_changed` — iff the loaded MCP advertised the `resources` capability and contributed any entries.
3. `notifications/prompts/list_changed` — iff the loaded MCP advertised the `prompts` capability and contributed any entries.

See [Dynamic Discovery > Capability Constraint](#capability-constraint) for the important caveat about what these notifications can and cannot achieve on the host side.

**Idempotency:** Calling `load_mcp` for an MCP that is already loaded (either an eager MCP from startup, or a lazy MCP loaded earlier in the session) returns the same structured listing with no side effects — no notifications are emitted, no reconnection occurs.

**Concurrency:** Concurrent `load_mcp` calls for **different** MCPs run in parallel. Concurrent `load_mcp` calls for the **same** MCP coalesce — the second call awaits the first's result and returns the same listing. Loads of distinct MCPs are independent: one failing does not affect the others.

**Error behavior:**
- If `mcp_name` does not match any entry in the config's `mcp` map, return an error listing the names of all currently-lazy (not-yet-loaded) MCPs. (Eager MCPs are intentionally omitted from this hint, since loading them is a no-op and the agent should be steered toward the lazy ones it might actually need.)
- If `mcp_name` matches an eager (already-loaded) MCP, treat it as a successful no-op per the idempotency rule above, returning the MCP's current listing. This is **not** an error.
- If the upstream connection or `initialize` handshake fails, return an error containing the underlying failure reason. The MCP remains in the lazy registry and can be retried by calling `load_mcp` again, up to the retry budget described below.
- If any of the post-initialize catalog queries (`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`) fail, the load is aborted as a whole: the upstream connection is closed, no notifications are emitted, the MCP remains lazy, and the failure is returned to the caller (subject to the same retry budget).

**Retry budget:** After **three consecutive failed load attempts** for the same MCP, the entry is evicted from the lazy registry. From that point on:

- Subsequent `load_mcp` calls for that name return the "unknown server" error.
- The entry disappears from the `<mcp_servers>` block of `discover_tool`'s description.
- `notifications/tools/list_changed` is emitted so the host re-reads the description and stops offering the evicted server to the agent.
- The third (eviction-triggering) failure's error message indicates that the MCP will no longer be offered for discovery.

A successful load resets the counter (irrelevant in practice, since success also calls `take` and removes the entry from the lazy registry).

This budget prevents an agent from indefinitely burning context retrying a permanently broken upstream while still tolerating two transient hiccups before giving up. Operators who need a higher tolerance should fix the upstream rather than expecting the proxy to retry past three.

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

## Dynamic Discovery

### Overview

By default, every upstream MCP listed in the config file is connected at startup (eager). When at least one entry declares a `description` field, dynamic discovery is **enabled** for the proxy as a whole:

- The `load_mcp` tool is registered and exposed to the host.
- The `discover_tool` description includes a `<mcp_servers>` block listing every lazy MCP, alongside the explanatory paragraph documented under [`discover_tool`](#discover_tool).
- Each MCP whose entry has a `description` is treated as **lazy** — its connection is deferred until `load_mcp` is called for it. MCPs whose entries do not have a `description` remain **eager** and connect at startup as today.

In single-MCP (`--`) mode there is no config entry and no place to declare a `description`, so dynamic discovery is never enabled in that mode.

### Lifecycle of a Lazy MCP

A lazy MCP is in exactly one of three states during the proxy's lifetime:

| State | Meaning |
|---|---|
| `lazy` | Configured but not connected. Appears in `<mcp_servers>`. Its tools, resources, and prompts are unknown to the proxy and invisible to the host. |
| `loading` | A `load_mcp` call is in flight: the transport is being opened, `initialize` is being negotiated, and the initial catalog queries (`tools/list`, plus `resources/list` + `resources/templates/list` + `prompts/list` for any declared capabilities) are being issued. Concurrent `load_mcp` calls for this same MCP attach to the same in-flight operation. |
| `loaded` | Connection and catalog queries succeeded. Tools are namespaced and merged into the live catalog. Resources and prompts are merged into the routers under the standard first-wins collision rules. The MCP behaves identically to an eager MCP from this point on, including subscriptions, server-initiated requests, progress, cancellation, logging, and `*/list_changed` propagation. |

Transitions: `lazy → loading → loaded` on success. On failure during `loading`, the partial connection is torn down and the MCP returns to `lazy`; the load is atomic — the host observes either all of the MCP's surfaces or none of them. There is no `unloaded` state; once `loaded`, an MCP remains loaded for the remainder of the proxy's lifetime (see [Non-Goals](#non-goals-explicit-exclusions)).

### Capability Constraint

This is the most important constraint of the dynamic-discovery design and follows directly from the MCP protocol:

> The proxy's host-facing capabilities are negotiated **once** during the host's `initialize` call. The MCP protocol has no `capabilities/changed` notification, so newly-loaded MCPs cannot cause the proxy to retroactively advertise capabilities it did not advertise at startup.

Concretely:

- Capabilities are aggregated only over **eagerly-loaded** MCPs at host-`initialize` time. Lazy MCPs contribute **nothing** to the host-facing capability set until they are loaded.
- The `tools` and `tools.listChanged` capabilities are always advertised regardless (see [Capability Aggregation](#capability-aggregation)), so a lazy MCP's tools always work via `load_mcp` → `use_tool` even when no eager MCP advertised the tools capability.
- A lazy MCP that advertises `resources`, `prompts`, `logging`, or `completions` will have those surfaces merged into the proxy's routers on load and the appropriate `*/list_changed` notification will be emitted — but if **no** eager MCP advertised that same capability at startup, hosts that strictly gate on the negotiated capability set will not listen for or query those surfaces. The notification is emitted regardless, on the theory that some hosts may handle it tolerantly and that emitting it is informationally correct.
- To guarantee that a particular capability is available to the host, at least one eagerly-loaded (non-`description`) MCP advertising that capability must be present in the config. Operators who want a lazy MCP's resources or prompts to be reliably reachable should either (a) keep that MCP eager, or (b) include some other eager MCP advertising the same capability so the host has negotiated to listen for it.

This trade-off is intentional: the alternative — eagerly probing every lazy MCP at startup just to read its capabilities, then disconnecting — would partially defeat the lazy-loading goal (slow startup, spurious child processes, transient HTTP connections to remote MCPs), and the value of advertising capabilities the host cannot actually reach without first calling `load_mcp` is limited.

### Interaction with the Rest of the Proxy

Once a lazy MCP transitions to `loaded`, every rule in [Proxy Behavior](#proxy-behavior) applies to it without exception. There is no distinction between a "loaded lazy" MCP and an "eager" MCP after the transition completes:

- Tool entries are added to the namespaced catalog. `discover_tool`'s description is regenerated and `notifications/tools/list_changed` is emitted.
- Resource and prompt entries are added to the routers using the standard first-wins collision policy. Collisions with existing entries are logged at warn level. `notifications/resources/list_changed` and/or `notifications/prompts/list_changed` are emitted as applicable.
- Subsequent upstream notifications (`notifications/resources/updated`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`, `notifications/tools/list_changed`, `notifications/message`) flow through the existing forwarder.
- `logging/setLevel` broadcasts from the host include the newly-loaded MCP from the next call onward.
- Server-initiated requests (`sampling/createMessage`, `elicitation/create`, `roots/list`) from the loaded MCP are forwarded to the host. The same capability constraint above applies — if no eager MCP declared those client-side capabilities at host-`initialize` time, the host may reject them, and that rejection is forwarded back to the upstream verbatim.
- `notifications/roots/list_changed` from the host is broadcast to the loaded MCP from then on, if it advertised the `roots` capability.

### Shutdown

Lazy MCPs that were never loaded require no teardown. Loaded MCPs are torn down identically to eager MCPs — child processes terminated, HTTP connections closed — as part of the standard proxy shutdown sequence.

---

## Proxy Behavior

### Overview

For every MCP protocol feature other than tools, `dynmcp` is a transparent, full-fidelity proxy. The agent host perceives the union of every upstream MCP's resources, prompts, completion, logging, and server-initiated request flows as a single composite MCP. This section specifies routing, aggregation, identifier handling, and lifecycle rules for that pass-through behavior.

### Capability Aggregation

During the host's `initialize` call, the proxy advertises a capability to the host iff at least one **eagerly-connected** upstream advertises it. Lazy (dynamic-discovery) upstreams are not yet connected at this point and contribute nothing to the negotiated capability set — see [Dynamic Discovery > Capability Constraint](#capability-constraint) for the rationale and implications.

| Capability | Rule |
|---|---|
| `tools` | Always advertised (proxy always exposes `discover_tool` and `use_tool`, plus `load_mcp` when dynamic discovery is enabled). |
| `tools.listChanged` | Always advertised. The proxy emits this notification whenever any upstream's tool list changes, or when an MCP transitions from `lazy` to `loaded`, so that the host refetches and re-reads the regenerated `discover_tool` description. |
| `resources` | Advertised iff any **eager** upstream advertises it. |
| `resources.subscribe` | Advertised iff any **eager** upstream advertises it. |
| `resources.listChanged` | Advertised iff any **eager** upstream advertises it. |
| `prompts` | Advertised iff any **eager** upstream advertises it. |
| `prompts.listChanged` | Advertised iff any **eager** upstream advertises it. |
| `logging` | Advertised iff any **eager** upstream advertises it. |
| `completions` | Advertised iff any **eager** upstream advertises it. |

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

In the example above, `chrome-devtools` declares a `description` and is therefore **lazy** — its connection is deferred and it is reachable only via `load_mcp`. The other three entries do not declare a `description` and are **eager** — they connect at startup as before. The presence of `chrome-devtools`'s `description` enables dynamic discovery for the proxy as a whole, which causes the `load_mcp` meta-tool to be registered and the `<mcp_servers>` block to appear in `discover_tool`'s description. See [Dynamic Discovery](#dynamic-discovery).

**Top-level fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `mcp` | `Record<string, McpEntry>` | Yes | Map of upstream MCPs to proxy. |
| `env` | `"enable" \| "dotenv" \| "process" \| "disable"` | No | Controls environment variable interpolation. Defaults to `"enable"`. See [Environment Variable Interpolation](#environment-variable-interpolation). |

**Map key:**

| Field | Type | Required | Description |
|---|---|---|---|
| `mcp.<key>` | `string` | Yes | The MCP name. Used as the namespace prefix for all its tools. Must match `/^[a-z0-9][a-z0-9-]*$/`. |

**Common entry fields (all transports):**

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `"stdio" \| "streamable-http" \| "sse"` | Yes | How `dynamic-discovery-mcp` connects to this upstream MCP. |
| `description` | `string` | No | When present, marks this MCP as **lazy** (dynamic-discovery). The MCP is not connected at startup; instead, this string is shown to the agent in the `<mcp_servers>` block of `discover_tool`'s description so the agent can decide whether to invoke `load_mcp` for it. Must be a non-empty string after environment-variable interpolation. The presence of this field on **any** entry enables dynamic discovery for the proxy as a whole. See [Dynamic Discovery](#dynamic-discovery). |

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
| `auth` | `object` | No | Pre-registered OAuth client credentials. When omitted, the proxy uses Dynamic Client Registration on first `dynmcp login`. See [Upstream OAuth > Auth Config](#auth-config). |

**Validation rules enforced at startup:**
- `stdio` entries must not include `url`, `headers`, or `auth`.
- `streamable-http` and `sse` entries must not include `command`, `args`, or `env`.
- `description`, if present, must be a non-empty string after environment-variable interpolation. An empty or whitespace-only `description` causes a startup error.
- `auth.client_id`, if `auth` is present, must be a non-empty string after environment-variable interpolation.

### YAML equivalent

```yaml
env: enable
mcp:
  chrome-devtools:
    description: >
      Browser automation via Chrome DevTools Protocol. Navigate pages, take
      screenshots, inspect the DOM, run JavaScript in page context.
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

- `description` (on any entry)
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

## Upstream OAuth

### Overview

`streamable-http` and `sse` upstream MCPs may require OAuth 2.1 authorization. `dynmcp` handles this auth out-of-band via the `dynmcp login` and `dynmcp logout` CLI subcommands, persisting tokens to the operating system's keychain (`@napi-rs/keyring`). The proxy process itself **never** opens a browser, never blocks a host request waiting for human action, and never accepts credentials interactively over stdio. All interactive auth happens in a separate `dynmcp login` invocation from the user's terminal.

`stdio` upstreams are out of scope — OAuth is irrelevant for locally-spawned subprocesses.

Auth is **auto-detected** from the protocol per the [MCP Authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization): when an upstream returns `HTTP 401 Unauthorized` with a `WWW-Authenticate: Bearer resource_metadata=<url>` header, the proxy's auth provider kicks in. No config field is required to "turn on" OAuth; the absence of cached credentials in the keychain plus a 401 challenge is the trigger.

### Supported OAuth Surface

| Feature | Status |
|---|---|
| OAuth 2.1 authorization-code grant with PKCE (RFC 7636) | Required |
| Protected Resource Metadata discovery (RFC 9728) | Required |
| Authorization Server Metadata discovery (RFC 8414) | Required |
| Dynamic Client Registration (RFC 7591) | Default — used when no `auth` config block is present |
| Pre-registered client credentials via config | Optional — see [Auth Config](#auth-config) |
| Access token refresh via refresh token | Required (silent, in-process) |
| Device-code grant (RFC 8628) | **Non-goal** for v1 |
| Client-credentials grant | **Non-goal** for v1 |
| Implicit grant | **Non-goal** (deprecated in OAuth 2.1) |

### Auth Config

A new optional `auth` field is added to the `streamable-http` and `sse` transport entries in the config file:

| Field | Type | Required | Description |
|---|---|---|---|
| `auth.client_id` | `string` | Yes (if `auth` present) | Pre-registered OAuth client ID. Supplying this disables Dynamic Client Registration for this MCP. |
| `auth.client_secret` | `string` | No | Pre-registered OAuth client secret for confidential clients. Public clients (PKCE-only) should omit this. |
| `auth.scope` | `string` | No | Space-separated OAuth scopes to request. Overrides the scopes advertised in the server's protected-resource metadata. |

Example:

```json
{
  "mcp": {
    "linear": {
      "transport": "streamable-http",
      "url": "https://mcp.linear.app",
      "auth": {
        "client_id": "${LINEAR_OAUTH_CLIENT_ID}",
        "client_secret": "${LINEAR_OAUTH_CLIENT_SECRET}",
        "scope": "read write"
      }
    },
    "notion": {
      "transport": "streamable-http",
      "url": "https://mcp.notion.com"
    }
  }
}
```

In this example, `linear` uses operator-supplied credentials, while `notion` relies on Dynamic Client Registration (no `auth` block).

Notes:

- `auth` is **only** valid on `streamable-http` and `sse` entries. Validation rejects it on `stdio`.
- `auth.client_id` and `auth.client_secret` are interpolation targets — values like `${LINEAR_OAUTH_CLIENT_ID}` work per [Environment Variable Interpolation](#environment-variable-interpolation).
- Authorization-server endpoint URLs (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`) are **always** discovered via RFC 8414 metadata. There is no config override for them — servers that don't expose RFC 8414 metadata are unsupported. This avoids drift between configured and actual endpoints.

### Keychain Storage

| Aspect | Value |
|---|---|
| Library | `@napi-rs/keyring` (macOS Keychain, Linux libsecret, Windows Credential Manager) |
| Service | `dynmcp` |
| Account | `<mcp-name>:<resource-server-origin>` — e.g. `linear:https://mcp.linear.app` |
| Value | JSON blob (see schema below) |

The account format includes the resource server origin so that re-pointing an MCP name at a different URL in config does not silently authenticate against stale tokens — the keychain entry simply won't be found and a fresh `dynmcp login` is required.

**Blob schema:**

```ts
{
  access_token: string,
  token_type: "Bearer",
  expires_at: number,              // Unix epoch seconds, computed from `expires_in` at issue time
  refresh_token?: string,          // present iff the server issued one
  scope_granted?: string,          // space-separated scopes actually granted
  authorization_server: {
    issuer: string,
    authorization_endpoint: string,
    token_endpoint: string,
    registration_endpoint?: string,
    revocation_endpoint?: string
  },
  resource_metadata: {
    resource: string,              // canonical resource URI
    authorization_servers: string[]
  },
  dcr?: {                          // present iff DCR was used (no `auth` config block)
    client_id: string,
    client_secret?: string,        // present iff the server registered as confidential
    registration_access_token?: string,  // RFC 7591 §3.2.1
    registration_client_uri?: string
  }
}
```

When the user supplied `auth.client_id` / `auth.client_secret` via config, those values are read from config at use time and **not** mirrored into the keychain. Rotating credentials in config does not require a logout.

### `dynmcp login <name>`

Interactive OAuth flow for a single upstream MCP.

**Behavior:**

1. Validate that `<name>` exists in the config file and that its transport is `streamable-http` or `sse`. Reject `stdio` entries with a clear error.
2. Connect to the upstream URL with no `Authorization` header to trigger the 401 challenge, then read the `resource_metadata` URL from the `WWW-Authenticate` header.
3. Fetch the RFC 9728 protected-resource metadata. Pick the first entry from `authorization_servers`. Fetch its RFC 8414 metadata.
4. **If** the config has no `auth` block for this MCP **and** no DCR record is cached in the keychain for it: perform RFC 7591 Dynamic Client Registration against `registration_endpoint`. Cache the registration in the keychain blob (committed only after the full flow succeeds — see step 9).
5. Bind a local HTTP server on `127.0.0.1` at an OS-assigned ephemeral port. The redirect URI is `http://127.0.0.1:<port>/callback`.
6. Generate a PKCE code verifier + challenge (S256) and a `state` value (CSPRNG, 32 bytes, base64url). Construct the authorization URL using scopes from `auth.scope` if present, else from the protected-resource metadata.
7. Open the authorization URL in the user's default browser (`open` on macOS, `xdg-open` on Linux, `start` on Windows). If launching the browser fails, print the URL to stderr with instructions to paste it manually.
8. Wait for the redirect callback on the local server, with a 60-second timeout. Validate `state` matches; reject mismatches without exchanging the code. The callback responds with a minimal HTML page ("You may close this tab and return to your terminal.") and shuts down the local server.
9. POST to `token_endpoint` with the authorization code and PKCE verifier. On success, persist the keychain blob (overwriting any prior entry for this account) and print success to stderr. On failure, print the error and exit non-zero; no keychain write occurs and any newly-generated DCR registration is discarded.

**Errors:**

- `<name>` not found or wrong transport → exit non-zero with a clear message.
- Single-MCP mode (`--`) → not applicable; `dynmcp login` requires a config file and rejects with an explanatory error.
- The upstream does not return a 401 challenge or returns no `resource_metadata` URL → exit non-zero. The MCP does not require OAuth and credentials are not stored.
- RFC 9728 or RFC 8414 metadata missing or malformed → exit non-zero with the underlying parse error.
- Browser callback timeout → exit non-zero. No keychain write.
- State mismatch on callback → exit non-zero. No keychain write.
- Token exchange failure → exit non-zero. No keychain write.

**Re-auth:** Running `dynmcp login <name>` against an MCP that already has cached credentials simply re-runs the flow and overwrites the keychain entry on success. There is no separate `refresh` subcommand — silent refresh is handled in-process by the proxy.

### `dynmcp logout <name>`

Removes the keychain entry for `<name>`. No network calls — the server is **not** notified (token revocation is not supported in v1).

**Behavior:**

1. Validate that `<name>` exists in the config and that its transport is `streamable-http` or `sse`.
2. Delete the keychain entry at `service=dynmcp, account=<mcp-name>:<resource-server-origin>`.
3. Print success to stderr. Missing entry is treated as success (idempotent).

**Errors:** Same validation errors as `login`. Keychain write failures are surfaced.

### Proxy Runtime Behavior

The proxy's `UpstreamClient` for HTTP/SSE transports is wired with an `OAuthClientProvider` (the MCP SDK's auth integration point). The provider:

- Reads the keychain entry for the upstream's account on every outbound request and attaches `Authorization: Bearer <access_token>`.
- If the cached `access_token` is within 30 seconds of `expires_at`, performs a silent refresh against `token_endpoint` using `refresh_token` (if present) **before** the next outbound request. Successful refresh writes the new tokens back to the keychain atomically (single `setPassword` call). Failed refresh treats the credentials as invalid (see below).
- If a request returns 401 mid-session, attempts exactly one silent refresh + retry. If the retry also 401s (or no refresh token is available), credentials are treated as invalid.

**When credentials are missing or invalid:**

- During `load_mcp` (lazy upstream): the upstream connection's `initialize` handshake fails with an `AuthRequiredError`. The error message returned to the agent is: *"Upstream MCP '<name>' requires authorization. Run `dynmcp login <name>` from your terminal, then retry `load_mcp`."* This failure **does not count toward the lazy-upstream retry budget** described in [`load_mcp`](#load_mcp) — auth-required failures are operator-actionable, not transient, and counting them would cause silent eviction before the user can act.
- During startup (eager upstream): startup fails with the same actionable error message. The proxy refuses to start until either the credentials are obtained or the MCP is reconfigured.
- During normal in-session use (loaded upstream, post-refresh 401): the offending host-facing request returns an error with the same actionable message. The MCP remains connected for non-auth-requiring operations (where applicable); subsequent auth-requiring requests will continue to fail until the user re-runs `dynmcp login`. The proxy does **not** disconnect, evict, or otherwise modify the catalog — recovery is one CLI command away.

### Local Callback Server

| Aspect | Value |
|---|---|
| Bind address | `127.0.0.1` only (never `0.0.0.0`) |
| Port | OS-assigned ephemeral (request port `0`) |
| Path | `/callback` (only path served) |
| Methods | `GET` only |
| Lifetime | Started immediately before opening the browser; shut down on first valid callback or after 60-second timeout, whichever comes first |
| Other paths | Return `404` |
| Other methods | Return `405` |

The redirect URI sent to the authorization server is reconstructed each flow from the actual bound port (`http://127.0.0.1:<port>/callback`) and registered dynamically via DCR (when DCR is in use). When pre-registered client credentials are used, the operator must ensure their pre-registered client allows the loopback redirect pattern.

### Concurrency

`dynmcp login <name>` and `dynmcp logout <name>` must not run concurrently against the same `<name>`. Keychain writes are not transactional across processes; running two `login`s for the same MCP races to overwrite the entry. This is documented but not enforced — the surface area is small enough that a lock file would be more friction than benefit.

The proxy's in-process silent refresh path serializes per-MCP via a single in-flight promise (same pattern as `inFlightLoads` in [`load_mcp`](#load_mcp)) so that bursts of host requests don't all trigger concurrent refresh attempts.

---

## Diagnostic Subcommands

`dynmcp` exposes two non-proxy subcommands to help operators inspect their configuration and verify upstream MCPs are reachable: `dynmcp ls` and `dynmcp test`. Both are config-file-mode-only — single-MCP (`--`) mode has nothing to list and only one MCP to test (just run the proxy).

### `dynmcp ls`

Lists every upstream MCP declared in the resolved config along with its connection summary and auth status. Pure config + keychain read; no network calls.

**Behavior:**

1. Load and validate the config (same pipeline as the proxy commands).
2. For each entry, gather: name, transport, mode (eager / lazy), endpoint, and auth status.
3. Render the result as either an aligned text table (default) or a JSON array (`--json`).

**Auth status values:**

| Transport | Auth status |
|---|---|
| `stdio` | `n/a` (OAuth is out of scope for stdio) |
| `streamable-http` / `sse`, with `headers.Authorization` set | `header` |
| `streamable-http` / `sse`, with a valid keychain entry | `oauth: logged in (expires in <duration>)` where `<duration>` is humanized from the cached `expires_at` |
| `streamable-http` / `sse`, no keychain entry | `oauth: not logged in` |

When both static `headers.Authorization` and a keychain entry are present, the keychain entry wins in display (the OAuth token is what the proxy will actually attach), and the entry is annotated `oauth: logged in ... (header also set)`.

**Output (default text):** an aligned table with `NAME`, `TRANSPORT`, `MODE`, `ENDPOINT`, `AUTH` columns. The endpoint for stdio is `command + args` joined by spaces, truncated with `...` if it exceeds the column width. URLs for http/sse are printed verbatim.

**Output (`--json`):** an array of objects matching the table columns, plus a `description` field for lazy entries and an `auth.expires_at` epoch number where applicable.

**Flags:**

| Flag | Description |
|---|---|
| `--config <path>` / `-c` | Standard config path override. |
| `--env <path>` / `-e` | Standard `.env` path override. |
| `--json` | Emit JSON instead of the table. |

**Constraints:**

- Config-file mode only. Running `dynmcp ls` with no config (and no `--`) is an error like every other config-mode command.
- The keychain read may prompt the user on macOS the first time. This is OS behavior, not something `dynmcp` can suppress.

**Exit codes:** `0` if the config loads; non-zero on config error.

### `dynmcp test [name]`

Actively probes one or all upstreams and reports per-step results. Doubles as a "what's in this MCP?" introspection tool — single-MCP test mode prints the full discovered surface (tools, resources, resource templates, prompts).

**Behavior (per MCP):**

1. Resolve the config entry by name.
2. Build the SDK transport via the same `transport-factory` used by the proxy.
3. For OAuth-applicable upstreams, report whether a token is present and (if present) its remaining lifetime.
4. Open the transport and complete the MCP `initialize` handshake. Capture the negotiated protocol version and advertised server capabilities.
5. Call `tools/list`; if the server advertises `resources`, also call `resources/list` + `resources/templates/list`; if it advertises `prompts`, also call `prompts/list`. Failures within a single capability are reported as their own step and do not abort earlier successes.
6. Disconnect cleanly. Lazy upstreams remain configured-but-not-loaded.

**Output (single MCP, default):** a step-by-step pass/fail log followed by a `PASS` / `FAIL` verdict. On success, the full discovered surface is printed:

- `Tools (N):` — bulleted list, sorted by name. Each line is `<name>: <description>` with the description truncated to ~100 characters and suffixed with `...` if longer.
- `Resources (N):` — bulleted list, sorted by URI. Format `<uri>: <description>` (or `<uri>: <name>` if no description).
- `Resource templates (N):` — bulleted list, sorted by URI template. Same format.
- `Prompts (N):` — bulleted list, sorted by name.

Empty sections (count of zero) are omitted entirely — no `Resources (0):` header.

**Output (all MCPs, default — when `name` is omitted):** a single compact line per MCP with `PASS`/`FAIL` and counts only. Failures include a one-line reason. A final `Summary: <passed> passed, <failed> failed` line follows.

**Output (`--json`):**

- For single-MCP test: one object containing `name`, `result` (`"PASS"` / `"FAIL"`), `transport`, `endpoint`, `auth` (kind + status + remaining seconds), `protocol_version`, `capabilities`, `tools`, `resources`, `resource_templates`, `prompts`, and a `steps` array with per-step status and any error messages.
- For all-MCP test: an array of those objects plus a top-level `summary: { passed, failed }`.

**Flags:**

| Flag | Description |
|---|---|
| `--config <path>` / `-c` | Standard config path override. |
| `--env <path>` / `-e` | Standard `.env` path override. |
| `--json` | Emit JSON instead of the formatted output. |
| `--timeout <ms>` | Per-MCP timeout in milliseconds. Default: `15000`. The timeout covers transport open + initialize + all catalog queries. Exceeding it produces a FAIL with a clear timeout message. |

**Constraints:**

- Config-file mode only.
- All-mode tests run **sequentially**, not in parallel, to keep output readable and avoid pile-ups on stdio MCPs that spawn child processes.
- Failures during one MCP do not abort tests of the remaining MCPs in all-mode.
- Lazy upstreams are tested by connecting transiently and disconnecting after. They are **not** permanently loaded; their lazy registration is independent of any in-process proxy and not affected.
- Auth-required failures are reported as clean FAILs with the actionable `Run \`dynmcp login <name>\`` message. The retry-budget logic that applies to `load_mcp` is NOT in effect here — `test` is a one-shot diagnostic.

**Exit codes:**

- `dynmcp test <name>`: `0` if PASS, `1` if FAIL.
- `dynmcp test` (no name): `0` if every MCP passed, `1` if any failed.

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
2. If config file mode, locate and parse the config file, perform environment-variable interpolation, then validate against the Zod schema.
3. Partition entries into **eager** (no `description`) and **lazy** (has `description`). If any entry is lazy, dynamic discovery is enabled for the proxy (the `load_mcp` meta-tool will be registered and the `<mcp_servers>` block will be included in `discover_tool`'s description).
4. Connect only to **eager** upstreams — spawn as child processes for `stdio` entries, or open HTTP connections for `streamable-http` and `sse` entries. Negotiate `initialize` with each eager upstream and record its declared capabilities. Lazy upstreams are not contacted at this stage; only their names and descriptions are registered.
5. Query each eager upstream for its full tool list, and (for capability-advertising eager upstreams) prompts, resource templates, and initial resource list. Detect resource-URI and prompt-name collisions and log warnings.
6. Build the `discover_tool` description from the combined namespaced tool catalog (eager MCPs only at this stage) plus, when dynamic discovery is enabled, the `<mcp_servers>` block for the lazy MCPs. Build the aggregated capability set for the host-facing `initialize` response — see [Capability Aggregation](#capability-aggregation), noting that lazy MCPs contribute nothing here.
7. Start accepting MCP requests from the parent over stdio.

Subsequent `load_mcp` calls during runtime perform the equivalent of steps 4–5 scoped to a single lazy upstream, then trigger a regeneration of `discover_tool`'s description and the appropriate `*/list_changed` notifications. See [Dynamic Discovery > Lifecycle of a Lazy MCP](#lifecycle-of-a-lazy-mcp).

**Shutdown:** When the parent disconnects or the process receives SIGTERM/SIGINT, all spawned child processes are terminated before exit. HTTP connections are closed. Any in-flight server-initiated requests against the host are abandoned without forwarding their responses. Lazy MCPs that were never loaded require no teardown.

---

## CLI Interface

```
dynmcp [options] [-- <upstream-command> [upstream-args...]]
dynmcp login <name> [options]
dynmcp logout <name> [options]
dynmcp ls [options]
dynmcp test [name] [options]
```

| Flag / Option | Short | Description |
|---|---|---|
| `--version` | `-v` | Print the package version and exit |
| `--help` | `-h` | Print usage information and exit |
| `--config <path>` | `-c` | Path to config file (JSON or YAML) |
| `--env <path>` | `-e` | Path to a custom `.env` file for environment variable interpolation. See [Environment Variable Interpolation](#environment-variable-interpolation). |
| `--` | | Delimiter; everything after is treated as the upstream MCP command (single-MCP mode) |

**Mode resolution:**
1. If the first positional argument is `login`, `logout`, `ls`, or `test` → subcommand mode (see below).
2. Otherwise if `--` is present → single-MCP proxy mode (config file ignored).
3. Otherwise → config file proxy mode (auto-discovered or via `-c`).

**Subcommands:**

| Subcommand | Description |
|---|---|
| `login <name>` | Run the OAuth authorization-code flow for the named upstream MCP and persist tokens to the keychain. See [Upstream OAuth](#upstream-oauth). Requires config file mode. Accepts `--config` / `-c` and `--env` / `-e`. |
| `logout <name>` | Delete the keychain entry for the named upstream MCP. Idempotent. Requires config file mode. Accepts `--config` / `-c` and `--env` / `-e`. |
| `ls` | List every upstream MCP in the resolved config with its transport, mode, endpoint, and auth status. No network calls. See [Diagnostic Subcommands](#diagnostic-subcommands). Accepts `--config` / `-c`, `--env` / `-e`, and `--json`. |
| `test [name]` | Probe one or all upstream MCPs by connecting, completing `initialize`, and printing the discovered tool / resource / prompt catalog. See [Diagnostic Subcommands](#diagnostic-subcommands). Accepts `--config` / `-c`, `--env` / `-e`, `--json`, and `--timeout <ms>`. |

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
- An `unload_mcp` counterpart to `load_mcp`. Loaded upstreams remain loaded for the proxy's lifetime; thrashing connections does not advance the context-management goal that motivated dynamic discovery in the first place. See [Dynamic Discovery](#dynamic-discovery).
- Eager probing of lazy MCPs at startup to discover their capabilities. The capability constraint documented in [Dynamic Discovery > Capability Constraint](#capability-constraint) is the deliberate trade-off.
- OAuth device-code grant, client-credentials grant, or any non-authorization-code OAuth flow. Authorization-code with PKCE covers interactive desktop use, which is the only scenario `dynmcp` supports. See [Upstream OAuth](#upstream-oauth).
- Browser-launched OAuth from within the proxy process. All interactive auth flows are user-initiated via `dynmcp login`. The proxy never opens a browser.
- Token revocation on `dynmcp logout`. The keychain entry is deleted locally; the upstream server is not notified.
- Multiple identities per upstream MCP. One keychain entry per `<mcp-name>:<resource-server-origin>` pair.
- Headless / CI authentication. OAuth flows require an interactive browser session.

---

## Revision History

| Date | Change |
|---|---|
| 2026-05-18 | Initial spec drafted |
| 2026-05-18 | Resolved: multi-MCP syntax (config file), tool name collisions (namespace prefix), config file format (JSON + YAML), `discover_tool` description format (`<tools>` XML block) |
| 2026-05-18 | Added `streamable-http` and `sse` transport support to config file schema for connecting to remote upstream MCPs |
| 2026-05-18 | Added environment variable interpolation in config file leaf string values (`${VAR}` and `${VAR:-default}` syntax, `$${...}` escape). New top-level `env` field (`"enable"` default, `"dotenv"`, `"process"`, `"disable"`). New `--env` / `-e` CLI flag for custom `.env` path. Removed corresponding non-goal. |
| 2026-05-18 | Added full-fidelity upstream proxying for resources, prompts, completion, logging, notifications, cancellation, progress, and server-initiated requests (`sampling/createMessage`, `elicitation/create`, `roots/list`). New "Proxy Behavior" section. Resource URIs and prompt names pass through verbatim with first-config-wins collision resolution; tool names remain namespaced. Removed corresponding non-goals. |
| 2026-05-18 | Added dynamic discovery: per-entry optional `description` field in the config file marks an MCP as lazy. New `load_mcp` meta-tool (registered only when dynamic discovery is enabled) connects a lazy MCP on demand and returns its tools, resources, and prompts. New `<mcp_servers>` block in `discover_tool`'s description lists not-yet-loaded MCPs. New "Dynamic Discovery" section codifies the lazy lifecycle, idempotency / concurrency semantics, and the capability-aggregation constraint (lazy upstreams contribute nothing to host-`initialize` capability negotiation; their non-tool surfaces are best-effort on load). Added a three-strike retry budget on failed `load_mcp` attempts: after three consecutive failures the lazy entry is evicted, `tools/list_changed` fires, and subsequent calls receive "unknown server". New non-goals: no `unload_mcp`; no eager capability probing. |
| 2026-05-24 | Added upstream OAuth (streamable-http / sse only). OAuth 2.1 authorization-code with PKCE, RFC 9728 protected-resource discovery, RFC 8414 authorization-server discovery, RFC 7591 Dynamic Client Registration. Optional `auth: { client_id, client_secret?, scope? }` on http/sse config entries skips DCR. Tokens persisted to OS keychain via `@napi-rs/keyring` (service: `dynmcp`, account: `<mcp-name>:<resource-server-origin>`). New CLI subcommands `dynmcp login <name>` and `dynmcp logout <name>`. Local 127.0.0.1 callback server on ephemeral port with 60s timeout. Auth-required failures during `load_mcp` are exempt from the lazy retry budget. Added non-goals: device-code/client-credentials flows, in-proxy browser launching, token revocation, multi-identity, headless auth. |
| 2026-05-24 | Added diagnostic subcommands `dynmcp ls` and `dynmcp test [name]`. `ls` prints an aligned table of configured upstreams (name / transport / mode / endpoint / auth status), reading config + keychain only with no network calls. `test` probes one or all upstreams: opens transport, completes `initialize`, queries the advertised catalogs, and (in single-MCP mode) prints the full discovered tool / resource / prompt surface. All-MCP `test` runs sequentially and continues past failures, exiting non-zero if any failed. Both subcommands support `--json`; `test` adds `--timeout <ms>` (default 15000). |
