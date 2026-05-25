---
title: CLI Reference
description: Complete reference for the dynmcp command-line interface.
---

```
dynmcp [options] [-- <upstream-command> [upstream-args...]]
dynmcp init [options]
dynmcp add <name> [options]
dynmcp login <name> [options]
dynmcp logout <name> [options]
dynmcp ls [options]
dynmcp test [name] [options]
```

## Options

| Flag | Short | Description |
|---|---|---|
| `--version` | `-v` | Print the package version and exit. |
| `--help` | `-h` | Print usage information and exit. |
| `--config <path>` | `-c` | Path to a config file (JSON or YAML). |
| `--env <path>` | `-e` | Path to a custom `.env` file for [environment variable interpolation](/guides/environment-variables/). |
| `--` | | Delimiter. Everything after is the upstream MCP command (single-MCP mode). |

## Subcommands

| Subcommand | Description |
|---|---|
| `init` | Write a starter config file (`mcp.json` by default; `mcp.yaml` with `--yaml`) in the current directory. Accepts `--path`, `--yaml`, `--force`. See [Scaffolding a config](#scaffolding-a-config). |
| `add <name>` | Insert a new MCP entry into the resolved config file from flag-based inputs. Accepts `--transport` / `-t`, `--config` / `-c`, `--description`, `--command`, `--arg`, `--env`, `--url`, `--header`, `--client-id`, `--client-secret`, `--scope`, `--force`. See [Scaffolding a config](#scaffolding-a-config). |
| `login <name>` | Run the OAuth authorization-code flow for an upstream MCP and persist tokens to the keychain. See the [OAuth Authentication guide](/guides/oauth-authentication/). Requires config file mode. |
| `logout <name>` | Delete the OAuth keychain entry for an upstream MCP. Idempotent. Requires config file mode. |
| `ls` | List configured upstream MCPs with transport, mode, endpoint, and auth status. No network calls. See the [Diagnostics reference](/reference/diagnostics/#dynmcp-ls). Accepts `--json`. Requires config file mode. |
| `test [name]` | Probe one or all configured upstreams and print the discovered tool / resource / prompt catalog. See the [Diagnostics reference](/reference/diagnostics/#dynmcp-test). Accepts `--json` and `--timeout <ms>`. Requires config file mode. |

`login`, `logout`, `ls`, and `test` all accept the same `--config` / `-c` and `--env` / `-e` flags as the proxy command. `init` accepts neither (it scaffolds a new file rather than reading one). `add` accepts `--config` / `-c` to target an existing file but does **not** accept `--env` / `-e` — it never interpolates `${VAR}` references, so a `.env` path would be meaningless. See [Scaffolding a config](#scaffolding-a-config) for details.

## Mode resolution

`dynmcp` runs in one of three modes:

1. If the first positional argument is `init`, `add`, `login`, `logout`, `ls`, or `test` → subcommand mode (see [Subcommands](#subcommands)).
2. Otherwise, if `--` is present → single-MCP proxy mode. Whatever comes after `--` is the upstream command, and any config file is ignored.
3. Otherwise → config file proxy mode. The config is located in this order:
   1. Path passed to `-c` / `--config`.
   2. `mcp.json` in the current working directory.
   3. `.mcp.json` in the current working directory.

With none of these present, `dynmcp` exits with a clear error.

## Examples

### Single MCP

```bash
# Wrap a single upstream MCP
npx dynmcp@latest -- npx -y chrome-devtools-mcp@latest

# Tool names are not namespaced in this mode
```

### Config file

```bash
# Auto-discover mcp.json or .mcp.json in cwd
npx dynmcp@latest

# Explicit config path
npx dynmcp@latest --config ./my-config.json
npx dynmcp@latest -c ./my-config.json
```

### Scaffolding a config

`dynmcp init` writes a starter config file in the current directory; `dynmcp add` appends new entries into it.

```bash
# Create mcp.json with $schema set and an empty mcp map
dynmcp init

# Create mcp.yaml instead
dynmcp init --yaml

# Custom path
dynmcp init --path ./configs/main.json

# Overwrite an existing file
dynmcp init --force
```

The file `init` writes is intentionally not yet runtime-valid — the schema requires at least one MCP entry, so the next `dynmcp add` (or a manual edit) makes it valid. The `init` command never overwrites without `--force`.

```bash
# Add a stdio upstream (transport defaults to stdio)
dynmcp add filesystem \
  --command npx \
  --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp

# Add a streamable-http upstream
dynmcp add github \
  --transport streamable-http \
  --url https://api.githubcopilot.com/mcp

# Add an SSE upstream with headers
dynmcp add events \
  --transport sse \
  --url https://api.example.com/sse \
  --header "Authorization: Bearer my-token"

# Mark an entry lazy (enables dynamic discovery)
dynmcp add chrome \
  --command chromium \
  --description "Chrome browser automation. Use for live web page interaction."

# Provide pre-registered OAuth client credentials (skips DCR on dynmcp login)
dynmcp add api \
  --transport streamable-http \
  --url https://api.example.com/mcp \
  --client-id my-app-id \
  --client-secret my-app-secret \
  --scope "read write"

# Set upstream env vars for a stdio process
dynmcp add svc \
  --command node \
  --arg server.js \
  --env LOG_LEVEL=debug \
  --env "TOKEN=\${API_TOKEN}"

# Overwrite an existing entry with the same name
dynmcp add filesystem --command other-cmd --force
```

`add` validates the new entry against the transport schema before writing. Invalid combinations (e.g. `streamable-http` without `--url`, or `--client-secret` without `--client-id`) fail before touching the file.

`add` never interpolates `${VAR}` references. Any `${VAR}` strings already in the file round-trip verbatim, and any `${VAR}` strings you pass on the command line are written as literal text — the actual values are pulled from `.env` at proxy run time. See [Environment Variables](/guides/environment-variables/).

For YAML configs, comments outside the modified `mcp.<name>` subtree are preserved on round-trip via the `yaml` library's Document API. Comments inside an entry being edited may not survive.

### Custom `.env` file

```bash
# Use ./secrets.env instead of ./.env for interpolation
dynmcp --env ./secrets.env
dynmcp -e ./secrets.env
```

`--env` combined with `env: "process"` or `env: "disable"` is rejected at startup. There's no `.env` to load in those modes, so the flag would contradict itself.

### OAuth login / logout

```bash
# Authenticate against a configured upstream MCP
dynmcp login github

# Same, with an explicit config path
dynmcp login github --config ./mcp.json

# Delete the stored tokens for an upstream MCP
dynmcp logout github
```

See the [OAuth Authentication guide](/guides/oauth-authentication/) for the full walkthrough and the [OAuth reference](/reference/oauth/) for field-level detail.

### Listing and testing

```bash
# Show every configured MCP with transport, mode, endpoint, and auth status
dynmcp ls

# Same, as JSON for piping into jq / scripts
dynmcp ls --json

# Probe a single MCP and print its full discovered catalog
dynmcp test github

# Probe every configured MCP and print a per-MCP summary
dynmcp test

# Override the per-MCP timeout for slow upstreams
dynmcp test github --timeout 30000
```

See the [Diagnostics reference](/reference/diagnostics/) for output details, JSON shapes, and exit codes.

## Exit behavior

`dynmcp` runs until the parent host disconnects, or until it receives `SIGTERM` / `SIGINT`. On shutdown:

- Spawned child processes (stdio upstreams) are terminated.
- HTTP connections (`streamable-http` and `sse` upstreams) are closed.
- In-flight server-initiated requests against the host are abandoned.
- Lazy MCPs that were never loaded need no teardown.

## Stdio communication

`dynmcp` always talks to the agent host over stdio. There's no `--port` or `--listen` flag, and no HTTP transport for the host-facing side. It's local-only by design.
