# src/diagnostics

Implementation of the operator-facing diagnostic subcommands `dynmcp ls` and `dynmcp test`. Both read the same config and (where applicable) the same keychain entries as the proxy runtime, but neither serves the MCP protocol — they're pure CLI tools used to inspect configuration and verify upstream reachability.

Read SPEC.md § "Diagnostic Subcommands" first — that's the behavioral contract.

## Module layout

| File | Purpose |
|---|---|
| `format.ts` | Pure helpers: `renderTable` (auto-width text table), `truncate` (with ellipsis), `humanizeDuration` (seconds → `47m` / `2h 30m` / `3d 4h` / `expired`). No I/O, no dependencies on the rest of the project. |
| `list.ts` | `dynmcp ls` — loads config, queries keychain per http/sse entry, builds `ListEntry[]`, renders as table or JSON. Pure config + keychain reads; no network. |
| `test.ts` | `dynmcp test [name]` — builds transport via `src/proxy/transport-factory`, drives a real `UpstreamClient` through connect → initialize → capability + tool/resource/prompt queries → disconnect. Reports per-step pass/fail and the full discovered surface (single-MCP mode) or one-line summaries (all-MCP mode). |
| `index.ts` | Barrel re-exports. |

## Key invariants

- **`ls` never connects to any upstream.** It only reads the config file and the OS keychain. Fast, deterministic, safe to run blindly in any directory with a config file.

- **`test` connects upstreams transiently** and disconnects in a `finally` block — even on failure or timeout. Lazy upstreams probed by `test` remain configured-but-not-loaded; they are not promoted into any persistent state because there is no proxy running.

- **All-mode `test` runs sequentially**, not in parallel. Sequential keeps output readable (`[N/M] name ... PASS`) and avoids pile-ups on stdio MCPs that spawn child processes (Chrome DevTools etc).

- **All-mode `test` continues past failures.** One bad MCP doesn't abort the rest. The final summary line + exit code (non-zero if any failed) communicates the overall outcome.

- **Auth-required failures are reported with the actionable login command.** `isAuthRequiredError` from `src/auth` is checked in `failReason()`; matched errors render as `auth required: run \`dynmcp login <name>\`` instead of leaking the raw `AuthRequiredError` message.

- **`test`'s per-MCP timeout wraps the entire pipeline.** Open + initialize + every catalog query share one budget (default 15s, overridable via `--timeout <ms>`). On timeout, the partial client is disconnected and the test FAILs with `Test timed out after Xms`.

- **The `client` reference is held in a `clientHolder` object**, not a `let` binding. TypeScript's flow analysis cannot see assignments made inside the async closure that wraps the work; a plain `let client: UpstreamClient | null` ends up narrowed to `null` (or `never`) in the `finally` block. The holder pattern sidesteps it without any unsafe casts.

- **JSON output writes a single chunk at the end** of the test pipeline, not as steps progress. Streaming JSON-per-step would be hostile to consumers expecting one top-level object / array.

- **`test` and `ls` are config-file-mode only.** Single-MCP (`--`) mode has nothing to list and only one MCP to test (just run the proxy). The CLI parses these as subcommands distinct from the proxy entry point.

## Output shape

The text output is deliberately ASCII-only — no chalk colors, no Unicode box-drawing, no spinners. The aligned-column format is portable across terminals and trivially pipeable to `grep` / `awk`. If we ever want color, gate it behind `--color` (default off when stdout is not a TTY).

Description truncation in `test`'s single-MCP output is fixed at 100 characters and uses `truncate()` from `format.ts`. The `--no-truncate` flag could be added later if users complain; v1 keeps output bounded.

## Test scaffolding

`tests/diagnostics/test.test.ts` mocks **three** modules to avoid touching real networks or the real keychain:

1. `@napi-rs/keyring` — replaced with an in-memory `Map`-backed `Entry` class. Same pattern as `tests/auth/*`.
2. `src/proxy/transport-factory.js` — `createTransport` returns an opaque `{}`; we never call methods on it.
3. `src/proxy/upstream-client.js` — `UpstreamClient` is replaced with a `FakeUpstreamClient` that reads from a per-test `scenarios` map keyed by MCP name. Scenarios can configure `failConnect: Error`, `hangConnect: true` (used to test timeouts), `capabilities`, `tools`, `resources`, `templates`, `prompts`.

Use `import { test as runTest }` to avoid the name collision with vitest's own `test` global.

## Things worth knowing if you touch this

- **`createTransport` is called per-test even though the mock returns an empty object.** This keeps the production code path exercised: if `createTransport` ever grows side effects (it does — it wires the OAuth provider), the diagnostic command exercises those wires.

- **Order of MCPs in `test` and `ls` is config-file order** (specifically `Object.entries(config.mcp)` order, which V8 preserves insertion order for string keys). Sorting would be hostile to the user's stated config layout.

- **`describeCapabilities` flattens nested booleans into a compact label** (`resources(subscribe,listChanged)`). It only includes true-valued booleans; an empty object `{}` renders as the bare capability name. If a capability gains new shape (non-boolean nested values), expand the helper rather than silently dropping them.

- **`hasBearerAuthHeader` is case-insensitive** on the header key (matches `Authorization`, `authorization`, `AUTHORIZATION`). The value is not inspected — any present `Authorization` header is treated as static-auth signal.

- **Date sourcing is injectable via `now()`.** Both `list` and `test` accept a `now` option that returns Unix seconds. Tests pin it to a fixed value (`1_000_000_000`) for deterministic expiry strings; production defaults to `Date.now() / 1000`.
