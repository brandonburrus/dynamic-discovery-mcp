# src/scaffold

Implementation of `dynmcp init` and `dynmcp add` — the config-management subcommands that bootstrap and grow the config file without forcing operators to hand-author JSON/YAML.

Read SPEC.md § "Config Management Subcommands" first — that's the behavioral contract.

## Module layout

| File | Purpose |
|---|---|
| `format.ts` | Pure helpers: `detectFormat(path)` (JSON vs YAML from extension, matching the loader's rule) and the `SCHEMA_URL` constant pointing at https://dynamicmcp.tools/config.json. No I/O. |
| `init.ts` | `dynmcp init` — writes a starter `mcp.json` (or `mcp.yaml` with `--yaml`) containing only `$schema` + empty `mcp: {}`. Refuses to overwrite without `--force`. |
| `add.ts` | `dynmcp add <name>` — builds an MCP entry from flags, validates against `transportConfigSchema`, and writes it back into the target config preserving format (and YAML comments where possible). |
| `index.ts` | Barrel re-exports. |

## Key invariants

- **`init` produces a file that is intentionally not yet runtime-valid.** The Zod schema requires `mcp` to be non-empty, so an empty `mcp: {}` will fail `loadConfig`. This is by design — `init` exists to scaffold, `add` exists to fill, and the proxy refuses to run on a stub. The "next step: run `dynmcp add`" hint printed by `init` makes the next move obvious.

- **`add` never interpolates `${VAR}` references.** It reads the file raw, mutates the parsed structure, and writes it back. Any `${VAR}` strings already in the file pass through unchanged, and any `${VAR}` strings supplied via flags are written as literal text. Operators can deliberately pass `--env 'TOKEN=${MY_TOKEN}'` to get a templated value committed to disk.

- **`add` validates only the single new entry**, not the full config. This is necessary because other entries may rely on env interpolation for validity (e.g. URLs containing `${BASE_URL}/mcp`). Running the proxy (or a future `dynmcp validate`) is still the way to confirm whole-file validity.

- **JSON round-trips lose nothing meaningful.** JSON has no comments; key insertion order is preserved by V8 for string keys; indentation is normalized to 2 spaces with a trailing newline. Reformatting damage is bounded to that indentation policy.

- **YAML edits go through `yaml.parseDocument` + `Document.setIn`** to preserve comments and most formatting. Comments inside the modified `mcp.<name>` subtree may be lost on round-trip; comments elsewhere survive. This is a deliberate trade-off — full comment-preserving in-subtree edits would require AST surgery on the inserted value, which is out of scope.

- **`--client-id` is required when `--client-secret` or `--scope` is provided.** Matches the schema's `auth` block (where `client_id` is mandatory). The error fires before any I/O so a partial-auth flag combination doesn't pollute the file.

- **The MCP-name pattern (`MCP_NAME_PATTERN` from `src/config/schema.ts`) is enforced before any file I/O.** A bad name throws immediately rather than after parsing + validating other content.

- **Config-path resolution reuses `resolveConfigPath`** from `src/config/loader.ts`, so auto-discovery rules (`mcp.json` first, then `.mcp.json` in cwd) match the proxy and diagnostic subcommands exactly. If `resolveConfigPath` throws "no config found", `add` re-throws with an actionable "run `dynmcp init`" hint appended.

- **`add` does NOT accept a `.env` / `-e` flag.** Unlike the root proxy command and `login`/`logout`/`ls`/`test`, `add` never reads env vars — interpolation only matters when *reading* a config, not when *writing* one. The freed `--env` flag name is used for `add`-specific upstream stdio env vars (`KEY=VAL` pairs).

## Things worth knowing if you touch this

- **`buildEntry` is the single construction site** for the new entry object. If you add a new field to the schema, add it here and let `transportConfigSchema.safeParse` catch any shape mismatch. Don't duplicate validation logic — Zod is the source of truth.

- **`writeJson` and `writeYaml` both take the raw file string** and return the new file string. They never touch the filesystem directly. This makes them trivially testable with in-memory inputs and lets the top-level `add` function own the file-I/O policy in one place.

- **YAML writes go through `parseDocument` even when the file is missing the `mcp` key.** This is intentional — the Document API handles "missing key" via `doc.set("mcp", {})`, which preserves any leading schema-directive comment. A naive "parse, mutate JS object, stringify" path would discard that comment.

- **Repeatable CLI flags (`--arg`, `--env`, `--header`) use a custom collector** in `src/cli.ts` because Commander's default behavior is "last wins" for single-value options. The collector function defaults to `[]` so the action handler always receives a `string[]` (never `undefined`).

- **`add`'s `--env <KEY=VAL>` and the root `--env <path>` flag are intentionally distinct semantics on the same flag name** (only because `add` does not accept the root flag). Both pieces of documentation (SPEC.md and this file) call this out — do not "unify" them.

## Test layout

- `tests/scaffold/init.test.ts` — file-creation, format detection, force-overwrite, output hints. Uses tmpdir + injected writers.
- `tests/scaffold/add.test.ts` — per-transport happy paths, validation, YAML comment preservation, force-overwrite, missing-config error. Uses tmpdir + real `resolveConfigPath` via explicit `configPath`.
