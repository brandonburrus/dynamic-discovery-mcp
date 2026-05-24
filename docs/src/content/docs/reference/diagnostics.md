---
title: Diagnostics
description: Reference for the dynmcp ls and dynmcp test subcommands.
---

`dynmcp` ships two non-proxy subcommands to help you inspect your configuration and verify upstream MCPs are reachable: `dynmcp ls` and `dynmcp test`. Both are config-file-mode only — single-MCP (`--`) mode has nothing to list and only one upstream to test.

## `dynmcp ls`

Prints an aligned table of every upstream MCP in the resolved config, including its transport, mode (eager / lazy), endpoint, and auth status. Pure config + keychain read — no network calls.

```bash
dynmcp ls
dynmcp ls --config ./mcp.json
dynmcp ls --json
```

### Output

```
NAME              TRANSPORT          MODE    ENDPOINT                                AUTH
chrome-devtools   stdio              lazy    npx -y chrome-devtools-mcp@latest       n/a
aws-knowledge     streamable-http    eager   https://knowledge-mcp.global.api.aws    n/a
github            streamable-http    eager   https://api.githubcopilot.com/mcp       oauth: logged in (expires in 47m)
remote-dcr        streamable-http    lazy    https://example.com/mcp                 oauth: not logged in
remote-bearer     streamable-http    eager   https://api.example.com/mcp             header
```

### Columns

| Column | Source |
|---|---|
| `NAME` | The map key under `mcp.<name>` in the config. |
| `TRANSPORT` | `stdio` / `streamable-http` / `sse`. |
| `MODE` | `lazy` if the entry has a `description` field, otherwise `eager`. |
| `ENDPOINT` | `command + args` joined with spaces for stdio; `url` for http/sse. Truncated with `...` if longer than 48 characters. |
| `AUTH` | See [auth status values](#auth-status-values) below. |

### Auth status values

| Status | Meaning |
|---|---|
| `n/a` | `stdio` transport — OAuth doesn't apply. |
| `header` | A static `Authorization` header is set in the config and no OAuth token is cached. |
| `oauth: not logged in` | http/sse with no static header and no cached keychain entry. Run [`dynmcp login <name>`](/reference/cli/#oauth-login--logout) to authenticate. |
| `oauth: logged in (expires in <duration>)` | A cached keychain entry exists; the duration is humanized from the stored `expires_at`. Negative durations render as `expired`. |
| `oauth: logged in (expires in <duration>) (header also set)` | Both a cached OAuth token and a static `Authorization` header exist. The OAuth token is what the proxy actually attaches. |

### Flags

| Flag | Description |
|---|---|
| `--config <path>` / `-c` | Path to config file. |
| `--env <path>` / `-e` | Path to a custom `.env` file. |
| `--json` | Emit a JSON array of entry objects instead of the text table. |

### JSON shape

```json
[
  {
    "name": "github",
    "transport": "streamable-http",
    "mode": "eager",
    "endpoint": "https://api.githubcopilot.com/mcp",
    "auth": {
      "kind": "oauth",
      "status": "logged_in",
      "expiresInSeconds": 2820,
      "expiresAt": 1700000000
    }
  }
]
```

### Notes

- The first time `dynmcp ls` reads from the keychain on macOS, the OS may prompt for access. This is standard Keychain behavior, not something `dynmcp` can suppress.
- Exit code is `0` if the config loads successfully, non-zero on a config error.

## `dynmcp test`

Probes one or all configured upstreams. For a single upstream, prints a step-by-step pass/fail log followed by the full discovered tool / resource / prompt catalog. For all upstreams, prints a one-line summary per MCP and a final totals line.

```bash
dynmcp test                    # test every configured MCP
dynmcp test github             # test just one
dynmcp test github --json
dynmcp test --timeout 30000    # raise the per-MCP timeout
```

### Single-MCP output

```
Testing "github" (streamable-http, https://api.githubcopilot.com/mcp)
  [ok] OAuth token present (expires in 47m)
  [ok] Connected and initialized
  [ok] Capabilities: tools(listChanged), resources(subscribe,listChanged), prompts
  [ok] tools/list returned 23 tools
  [ok] resources/list returned 5 resources, 2 templates
  [ok] prompts/list returned 3 prompts

Tools (23):
  - create_issue: Create a new issue in a repository
  - list_issues: List issues in a repository with optional filtering
  - get_pull_request: Read a pull request's metadata and review state
  - ...

Resources (5):
  - github://repos/{owner}: List repositories owned by a user or org
  - github://user: The authenticated user's profile
  - ...

Resource templates (2):
  - github://repo/{owner}/{name}/issues/{number}: Read a single issue
  - github://repo/{owner}/{name}/pulls/{number}: Read a single pull request

Prompts (3):
  - write-pr-description: Generate a PR description from issue context
  - ...

Result: PASS
```

Empty surface sections (count of zero) are omitted entirely — no `Resources (0):` header on MCPs without resources.

Tool, resource, and prompt descriptions are truncated to ~100 characters with `...` if longer. Entries within each section are sorted by name (or URI / template) for stable output.

### All-MCP output

```
Testing all configured upstreams (5)...

[1/5] chrome-devtools (stdio) ... PASS (54 tools, 0 resources, 0 prompts)
[2/5] aws-knowledge (streamable-http) ... PASS (8 tools, 0 resources, 0 prompts)
[3/5] github (streamable-http) ... FAIL (auth required: run `dynmcp login github`)
[4/5] remote-dcr (streamable-http) ... PASS (45 tools, 0 resources, 3 prompts)
[5/5] remote-bearer (streamable-http) ... PASS (3 tools, 0 resources, 0 prompts)

Summary: 4 passed, 1 failed
```

### Test steps per MCP

For each MCP being tested, the following steps run in order:

1. Resolve the config entry.
2. Report auth status (for http/sse only).
3. Open the transport and complete the MCP `initialize` handshake.
4. Print the negotiated server capabilities.
5. Call `tools/list`.
6. Call `resources/list` + `resources/templates/list` if the server advertised the `resources` capability.
7. Call `prompts/list` if the server advertised the `prompts` capability.
8. Disconnect.

A failure within `resources/list` doesn't abort `prompts/list` — each capability is probed independently. The overall result is `PASS` only if every step (other than informational status) succeeded.

### Flags

| Flag | Description |
|---|---|
| `--config <path>` / `-c` | Path to config file. |
| `--env <path>` / `-e` | Path to a custom `.env` file. |
| `--json` | Emit a JSON result object (single-MCP) or `{ summary, results }` (all-MCP) instead of the formatted output. |
| `--timeout <ms>` | Per-MCP timeout, in milliseconds. Default `15000`. Covers transport open + initialize + every catalog query. |

### Exit codes

| Invocation | Exit code |
|---|---|
| `dynmcp test <name>` | `0` if PASS, `1` if FAIL. |
| `dynmcp test` (no name) | `0` if every MCP passed, `1` if any failed. |

### Behavior notes

- **Sequential, not parallel.** All-mode tests run one upstream at a time to keep output readable and avoid pile-ups on stdio MCPs that spawn child processes.
- **Continues past failures.** In all-mode, one failing MCP does not skip the rest.
- **Lazy upstreams.** Tested by connecting transiently and disconnecting after. They are **not** permanently loaded; their lazy registration is independent of any in-process proxy.
- **Auth-required failures.** Reported as clean FAILs with the actionable `Run \`dynmcp login <name>\`` message. The retry-budget logic that applies to `load_mcp` is not in effect here — `test` is a one-shot diagnostic.
- **OAuth tokens.** A test may trigger a silent token refresh on an http/sse upstream with a near-expiry cached token. The refreshed token is written back to the keychain atomically, just as it would be under the live proxy.

### JSON shape (single-MCP)

```json
{
  "name": "github",
  "result": "PASS",
  "transport": "streamable-http",
  "endpoint": "https://api.githubcopilot.com/mcp",
  "auth": { "kind": "oauth", "status": "valid", "expiresInSeconds": 2820 },
  "capabilities": { "tools": { "listChanged": true }, "resources": {} },
  "tools": [{ "name": "create_issue", "description": "..." }],
  "resources": [{ "uri": "github://user", "name": "user" }],
  "resource_templates": [
    { "uriTemplate": "github://repo/{owner}/{name}/issues/{number}", "name": "issue" }
  ],
  "prompts": [{ "name": "write-pr-description", "description": "..." }],
  "steps": [
    { "label": "OAuth token present (expires in 47m)", "status": "ok" },
    { "label": "Connected and initialized", "status": "ok" }
  ]
}
```

### JSON shape (all-MCP)

```json
{
  "summary": { "passed": 4, "failed": 1 },
  "results": [
    { "name": "chrome-devtools", "result": "PASS", "..." },
    { "name": "github", "result": "FAIL", "fail_reason": "auth required: run `dynmcp login github`", "..." }
  ]
}
```
