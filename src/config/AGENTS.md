# src/config

Config file loading, validation, and environment variable interpolation for dynmcp.

## Pipeline

`loadConfig(options)` runs this pipeline in order — each step must complete successfully before the next:

1. **Path resolution** (`resolveConfigPath`) — explicit `--config` path, else auto-discover `mcp.json` then `.mcp.json` in cwd.
2. **Parse** — JSON or YAML based on file extension.
3. **Read env mode** — peek at the parsed object's top-level `env` field (before Zod validation, so we know what env sources to load). Unknown values fall back to `"enable"` and let Zod surface a precise error in step 6.
4. **Load env sources** (`loadEnv`) — merge `.env` and/or `process.env` per the env mode. `.env` takes precedence over `process.env` in `"enable"` mode.
5. **Interpolate** (`interpolateConfig`) — substitute `${VAR}` / `${VAR:-default}` references in every leaf string value reachable through the config tree, except the top-level `$schema` and `env` keys. Errors from missing variables are aggregated into a single `MissingEnvVarsError`.
6. **Zod validate** (`mcpConfigSchema.safeParse`) — the validated config has no template syntax remaining.

## Files

| File | Purpose |
|---|---|
| `schema.ts` | Zod schemas — single source of truth for runtime validation and JSON Schema generation. |
| `loader.ts` | The `loadConfig` pipeline + `resolveConfigPath` auto-discovery. |
| `interpolate.ts` | Pure string template substitution; collects missing vars and throws `MissingEnvVarsError`. |
| `env-sources.ts` | Resolves the merged variable map per the four env modes; enforces `--env` / mode compatibility. |
| `json-schema.ts` | Generates the published JSON Schema from the Zod schema (consumed by `scripts/generate-schema.ts`). |
| `index.ts` | Barrel re-exports. |

## Invariants

- **Interpolation runs before Zod validation, never after.** The validated config type (`McpConfig`) never contains `${...}` syntax — downstream consumers can treat string values as resolved.
- **Top-level `$schema` and `env` are passthrough.** They are never interpolated; this is enforced in `interpolateConfig`. Adding new top-level fields that should also be passthrough means updating `TOP_LEVEL_PASSTHROUGH_KEYS` in `interpolate.ts`.
- **`--env` / `envFilePath` is incompatible with env modes `"process"` and `"disable"`.** Rejected at startup in `loadEnv`.
- **A missing default `.env` in cwd is not an error** — it soft-fails. Only an explicit `--env <path>` that doesn't exist is fatal.
- **Single dotenv file.** No `.env.local`, `.env.production`, etc. — multi-environment files are out of scope.

## Test layout

- `tests/config/schema.test.ts` — Zod schema unit tests.
- `tests/config/loader.test.ts` — end-to-end config-loading integration tests (including env interpolation flow).
- `tests/config/interpolate.test.ts` — pure interpolator unit tests.
- `tests/config/env-sources.test.ts` — env-source loader unit tests.
- `tests/config/json-schema.test.ts` — JSON Schema generator tests.

When changing the Zod schema, the generated JSON Schema must be regenerated: `npm run generate:schema` (also runs automatically on `npm run build` via the prebuild hook).
