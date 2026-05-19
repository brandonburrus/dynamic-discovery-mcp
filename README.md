# Dynamic Discovery MCP

A proxy MCP that exposes meta-tools so agents can discover and call upstream MCP tools on demand, without loading every tool schema into the context window.

## The Problem

Large MCPs routinely expose tens to hundreds of tools. When several are active at once, every tool schema is injected into the context window on every request regardless of relevance — degrading decision quality and consuming tokens unnecessarily. For any given task, only a small subset of tools is actually relevant.

## How It Works

`dynmcp` sits in front of one or more upstream MCPs and exposes exactly two tools:

- **`discover_tool`** — its description contains a compact catalog of every upstream tool (name and one-line summary). Call it with a tool name to get that tool's full schema: description, parameters, types, and required fields.
- **`use_tool`** — executes a tool by name, proxying the call to the upstream MCP and returning its output unchanged.

The agent workflow: scan the catalog in `discover_tool`'s description to find relevant tools, call `discover_tool` to load the full schema of the one it needs, then call `use_tool` to execute it. Full schemas of tools the agent never needs never enter the context window.

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
