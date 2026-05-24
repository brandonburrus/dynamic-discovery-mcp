---
title: CLI Reference
description: Complete reference for the dynmcp command-line interface.
---

```
dynmcp [options] [-- <upstream-command> [upstream-args...]]
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
| `login <name>` | Run the OAuth authorization-code flow for an upstream MCP and persist tokens to the keychain. See the [OAuth Authentication guide](/guides/oauth-authentication/). Requires config file mode. |
| `logout <name>` | Delete the OAuth keychain entry for an upstream MCP. Idempotent. Requires config file mode. |
| `ls` | List configured upstream MCPs with transport, mode, endpoint, and auth status. No network calls. See the [Diagnostics reference](/reference/diagnostics/#dynmcp-ls). Accepts `--json`. Requires config file mode. |
| `test [name]` | Probe one or all configured upstreams and print the discovered tool / resource / prompt catalog. See the [Diagnostics reference](/reference/diagnostics/#dynmcp-test). Accepts `--json` and `--timeout <ms>`. Requires config file mode. |

Every subcommand accepts the same `--config` / `-c` and `--env` / `-e` flags as the proxy command.

## Mode resolution

`dynmcp` runs in one of three modes:

1. If the first positional argument is `login`, `logout`, `ls`, or `test` → subcommand mode (see [Subcommands](#subcommands)).
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
