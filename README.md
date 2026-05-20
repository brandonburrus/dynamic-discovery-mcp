# Dynamic Discovery MCP

A proxy MCP that exposes meta-tools so agents can discover and call upstream MCP tools on demand, without loading every tool schema into the context window.

## The Problem

Large MCPs routinely expose tens to hundreds of tools. When several are active at once, every tool schema is injected into the context window on every request regardless of relevance — degrading decision quality and consuming tokens unnecessarily. For any given task, only a small subset of tools is actually relevant.

## How It Works

`dynmcp` sits in front of one or more upstream MCPs and exposes exactly two tools:

- **`discover_tool`** — its description contains a compact catalog of every upstream tool (name and one-line summary). Call it with a tool name to get that tool's full schema: description, parameters, types, and required fields.
- **`use_tool`** — executes a tool by name, proxying the call to the upstream MCP and returning its output unchanged.

The agent workflow: scan the catalog in `discover_tool`'s description to find relevant tools, call `discover_tool` to load the full schema of the one it needs, then call `use_tool` to execute it. Full schemas of tools the agent never needs never enter the context window.

For larger configurations, an optional third tool — **`load_mcp`** — lets the agent defer **whole MCP servers** until needed. Servers declared with a `description` field aren't connected at startup; they appear in a `<mcp_servers>` block in `discover_tool`'s description with their description, and the agent calls `load_mcp` with the server's name to bring it online. See [Dynamic Discovery](#dynamic-discovery).

## Usage

Requires Node.js >= 20.

### Single MCP (quick start)

Prefix any MCP invocation with `dynmcp --`:

```bash
# Before — tool schemas go straight into context
npx -y chrome-devtools-mcp@latest

# With dynmcp — only discover_tool and use_tool are exposed
npx dynmcp@latest -- npx -y chrome-devtools-mcp@latest
```

Everything after `--` is the command used to launch the upstream MCP. Tool names are exposed as-is (no namespace prefix).

### Multiple MCPs (config file)

To proxy several MCPs at once, create a config file:

```bash
# Auto-discover mcp.json or .mcp.json in cwd
npx dynmcp@latest

# Or specify explicitly
npx dynmcp@latest --config ./my-config.json
```

When using a config file, tool names are namespaced as `<mcp-name>/<tool-name>` to avoid collisions.

## Config File

The config file declares upstream MCPs under a top-level `mcp` key. Three transport types are supported:

```json
{
  "$schema": "https://unpkg.com/dynmcp/schema/mcp-config.json",
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
    "aws-knowledge": {
      "transport": "streamable-http",
      "url": "https://knowledge-mcp.global.api.aws"
    },
    "remote-sse": {
      "transport": "sse",
      "url": "https://example.com/sse",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    }
  }
}
```

YAML is also supported (use `.yml` or `.yaml` extension).

### Transport Types

| Transport | Fields | Description |
|---|---|---|
| `stdio` | `command`, `args?`, `env?` | Spawns the MCP as a child process |
| `streamable-http` | `url`, `headers?` | Connects to a remote MCP over HTTP |
| `sse` | `url`, `headers?` | Connects to a remote MCP over Server-Sent Events |

### Config Discovery

When no `--` command is provided, `dynmcp` looks for a config file in this order:

1. Path from `-c` / `--config` flag
2. `mcp.json` in the current directory
3. `.mcp.json` in the current directory

### Naming Rules

MCP names (the keys in the config) must match `^[a-z0-9][a-z0-9-]*$`.

## Dynamic Discovery

When at least one entry in the config declares a `description` field, **dynamic discovery** is enabled. The named MCP becomes *lazy* — its connection is deferred until the agent explicitly calls `load_mcp` for it. The same trick that `discover_tool`/`use_tool` apply to tool schemas is now applied to whole servers: agents only pay context cost for servers they decide they need.

When dynamic discovery is on:

- A third meta-tool **`load_mcp`** is exposed to the host.
- `discover_tool`'s description gains a `<mcp_servers>` block listing every lazy MCP with the description from your config.
- `<tools>` shows only the catalog of eager (non-lazy) MCPs at startup. As the agent calls `load_mcp`, loaded servers are promoted into `<tools>`.

### Example config

```json
{
  "$schema": "https://unpkg.com/dynmcp/schema/mcp-config.json",
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

In this example, `filesystem` connects at startup. `chrome-devtools` and `aws-knowledge` stay lazy — neither child process is spawned and no HTTP connection is opened until the agent calls `load_mcp` with the corresponding name.

### Writing good descriptions

The description is what an agent reads to decide whether to load a server. Write it as if you were briefing a teammate who has never seen the MCP:

- **Lead with the verbs** the MCP enables ("navigate, click, screenshot...").
- **Mention the domain** ("Jira tickets", "AWS docs", "Chrome browser").
- **Include a "use when..." clause** describing the kind of task it's appropriate for.
- Keep it to a few sentences. The agent reads every lazy server's description on every `discover_tool` call.

### `load_mcp`

The `load_mcp` tool takes a single `mcp_name` argument matching a key under `mcp` in your config. On success it returns a structured listing of the now-available tools, resources, resource templates, and prompts, and the host receives `notifications/tools/list_changed` (plus `resources/list_changed` and `prompts/list_changed` when applicable) so `discover_tool`'s description refreshes.

Notable semantics:

- **Idempotent** — calling `load_mcp` for a server that is already loaded (or for an eager server) is a successful no-op returning the current listing.
- **Permanent** — loaded servers stay loaded for the lifetime of the `dynmcp` process. There is no `unload_mcp`.
- **Atomic on failure** — if the upstream fails to connect, initialize, or return its catalog, the partial state is torn down; the lazy entry remains in `<mcp_servers>` and the agent can retry.
- **Retry budget** — after **three** consecutive failed `load_mcp` attempts, the entry is evicted from `<mcp_servers>` entirely. Further calls return "unknown server". This prevents an agent from burning context retrying a permanently broken upstream.
- **Concurrency** — concurrent `load_mcp` calls for the same name coalesce onto one connection attempt; calls for different names run in parallel.

### Capability caveat

The MCP protocol negotiates capabilities (resources, prompts, completion, logging) **once** during the host `initialize` call. Lazy upstreams aren't connected at that point, so they contribute nothing to the negotiated capability set. Practical implications:

- A lazy MCP's **tools** always work via `load_mcp` → `use_tool` (the `tools` capability is always advertised).
- A lazy MCP's **resources or prompts** work reliably only if at least one eager MCP in your config also advertises that capability, so the host negotiated to listen for them. The proxy still emits the relevant `*/list_changed` notification on load — but hosts that strictly gate on negotiated capabilities may ignore it.

If you want a lazy MCP's resources and prompts to be reachable, keep at least one eager MCP that advertises the same capability, or simply leave the heavier MCP eager.

## Environment Variable Interpolation

Config files can reference environment variables in any string-typed leaf value using shell-style syntax. This is useful for keeping secrets (bearer tokens, API keys) and host-specific values (paths, ports) out of the config file itself.

```json
{
  "mcp": {
    "remote": {
      "transport": "streamable-http",
      "url": "${MCP_URL:-https://example.com/mcp}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

### Syntax

| Form | Behavior |
|---|---|
| `${VAR}` | Replaced with the value of `VAR`. Hard error at startup if `VAR` is undefined. |
| `${VAR:-default}` | Replaced with `VAR` if set and non-empty, otherwise the literal `default` (may contain spaces, colons, etc.). |
| `$${...}` | Escape — emits a literal `${...}` with no interpolation. |

Interpolation only applies to **leaf string values** inside the `mcp` map (and nested objects/arrays within it). Map keys, the top-level `$schema` field, and the top-level `env` field are never interpolated. Partial-string interpolation works — `"Bearer ${TOKEN}"` is valid.

If any referenced variables are missing without a default, `dynmcp` exits at startup with an error listing **all** of them at once (not one at a time).

### Sources (`env` field)

A top-level `env` field controls where variables are read from:

| Value | Behavior |
|---|---|
| `"enable"` (default) | Loads `.env` file (if present) and merges with `process.env`. `.env` values take precedence over `process.env` for the same key. |
| `"dotenv"` | Loads from `.env` file only. `process.env` is ignored. |
| `"process"` | Reads from `process.env` only. No `.env` file is loaded. |
| `"disable"` | Disables interpolation entirely — `${VAR}` is left literal. |

```json
{
  "env": "process",
  "mcp": { /* ... */ }
}
```

### `.env` File Discovery

By default, `dynmcp` looks for a file literally named `.env` in the current working directory. To use a different path, pass `--env` / `-e`:

```bash
dynmcp --env ./secrets.env
```

Combining `--env` with `env: "disable"` or `env: "process"` is rejected as incoherent (no `.env` would be loaded). If `--env` points to a file that does not exist, `dynmcp` exits with an error.

## CLI Reference

```
dynmcp [options] [-- <upstream-command> [upstream-args...]]
```

| Flag | Short | Description |
|---|---|---|
| `--version` | `-v` | Print the package version and exit |
| `--help` | `-h` | Print usage information and exit |
| `--config <path>` | `-c` | Path to config file (JSON or YAML) |
| `--env <path>` | `-e` | Path to a custom `.env` file for variable interpolation |
| `--` | | Everything after is the upstream MCP command (single-MCP mode) |

### Mode Resolution

1. If `--` is present, single-MCP mode is used (config file is ignored).
2. Otherwise, config file mode is used.

## Development

```bash
npm install
npm run build       # Compile to dist/
npm run typecheck   # Type-check without emitting
npm run check       # Biome lint + format
npm test            # Run tests
```
