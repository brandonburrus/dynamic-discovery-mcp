---
title: Environment Variables
description: Reference environment variables from the config file to keep secrets out of source control.
---

Config files can reference environment variables in any string value using shell-style `${VAR}` syntax. Use this to keep bearer tokens, API keys, paths, and other secrets out of the config file itself.

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

## Syntax

| Form | Behavior |
|---|---|
| `${VAR}` | Replaced with the value of `VAR`. Hard error at startup if `VAR` is undefined. |
| `${VAR:-default}` | Replaced with `VAR` if set and non-empty, otherwise the literal `default`. The default can contain anything, including spaces and colons (e.g. `${URL:-http://localhost:8080}`). |
| `$${...}` | Escape. Emits a literal `${...}` with no interpolation. |

Bare `$VAR` is not supported — only the `${...}` brace form.

Both full (`"${TOKEN}"`) and partial (`"Bearer ${TOKEN}"`) interpolation work.

## Where it applies

Interpolation runs on leaf string values inside the `mcp` map. That means:

- `description` (on any entry)
- `stdio.command`
- Each element of `stdio.args`
- Each value in `stdio.env`
- `streamable-http.url`, `sse.url`
- Each value in `streamable-http.headers`, `sse.headers`

It does not apply to:

- Map keys (MCP names under `mcp`, env var names under `stdio.env`, header names under `headers`).
- The top-level `$schema` field.
- The top-level `env` field.

## Sources: the `env` field

The top-level `env` field controls where variables come from. Default is `"enable"`.

| Value | Behavior |
|---|---|
| `"enable"` (default) | Load `.env` file if present, and read `process.env`. If the same variable exists in both, `.env` wins. |
| `"dotenv"` | `.env` file only. `process.env` is ignored. |
| `"process"` | `process.env` only. No `.env` file is loaded. |
| `"disable"` | Interpolation is off. `${VAR}` is left as a literal string; the escape `$${...}` has no effect. |

```json
{
  "env": "process",
  "mcp": { /* ... */ }
}
```

## `.env` file discovery

By default, `dynmcp` looks for a file named `.env` in the current working directory. Only one file is supported — patterns like `.env.local` or `.env.production` are out of scope.

To point at a different file, use `--env` / `-e`:

```bash
dynmcp --env ./secrets.env
```

When `--env` is set, the file must exist or `dynmcp` exits with an error. Combining `--env` with `env: "process"` or `env: "disable"` is rejected as incoherent — there'd be no `.env` to load.

If `env` is `"enable"` or `"dotenv"` and you didn't pass `--env`, a missing `.env` in cwd is fine. Interpolation just runs with whatever sources are left.

## Errors

All interpolation errors surface at startup, before any upstream MCP is contacted. The fatal ones:

- A `${VAR}` reference with no default, where `VAR` isn't defined in any active source. Missing variables are collected and reported all at once — you won't have to fix them one by one.
- `--env` combined with `env: "disable"` or `env: "process"`.
- `--env <path>` where the path doesn't exist or can't be read.
- A `.env` file that can't be parsed. The underlying parse error is surfaced.

## Example: token rotation in CI

```yaml
env: process
mcp:
  github-api:
    transport: streamable-http
    url: https://api.github.com/mcp
    headers:
      Authorization: "Bearer ${GITHUB_TOKEN}"
```

With `env: process`, this config refuses to start if `GITHUB_TOKEN` isn't set. Safe to commit, and you can't accidentally ship a placeholder.
