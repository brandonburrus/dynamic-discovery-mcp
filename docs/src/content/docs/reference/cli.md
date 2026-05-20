---
title: CLI Reference
description: Complete reference for the dynmcp command-line interface.
---

```
dynmcp [options] [-- <upstream-command> [upstream-args...]]
```

## Options

| Flag | Short | Description |
|---|---|---|
| `--version` | `-v` | Print the package version and exit. |
| `--help` | `-h` | Print usage information and exit. |
| `--config <path>` | `-c` | Path to a config file (JSON or YAML). |
| `--env <path>` | `-e` | Path to a custom `.env` file for [environment variable interpolation](/guides/environment-variables/). |
| `--` | | Delimiter. Everything after is the upstream MCP command (single-MCP mode). |

## Mode resolution

`dynmcp` runs in one of two modes.

If `--` is present, it's single-MCP mode. Whatever comes after `--` is the upstream command, and any config file is ignored.

Otherwise, it's config file mode. The config is located in this order:

1. Path passed to `-c` / `--config`.
2. `mcp.json` in the current working directory.
3. `.mcp.json` in the current working directory.

With neither `--` nor a config file, `dynmcp` exits with a clear error.

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

## Exit behavior

`dynmcp` runs until the parent host disconnects, or until it receives `SIGTERM` / `SIGINT`. On shutdown:

- Spawned child processes (stdio upstreams) are terminated.
- HTTP connections (`streamable-http` and `sse` upstreams) are closed.
- In-flight server-initiated requests against the host are abandoned.
- Lazy MCPs that were never loaded need no teardown.

## Stdio communication

`dynmcp` always talks to the agent host over stdio. There's no `--port` or `--listen` flag, and no HTTP transport for the host-facing side. It's local-only by design.
