# dynamic-discovery-mcp

A local CLI tool and MCP server that proxies one or more upstream MCPs and exposes only two meta-tools (`discover_tool` and `use_tool`) so agents can discover and call upstream tools on demand without loading every tool schema into the context window.

## Specification

**`SPEC.md` is the single source of truth for what this project is and what it does.** Before implementing any feature, the spec must be updated and agreed upon first. If a feature is not in `SPEC.md`, it does not get built. When any design decision is made, it must be recorded in `SPEC.md` before work begins.

Key points from the current spec:
- Local stdio only — no remote/HTTP deployment.
- Two exposed tools: `discover_tool` (dynamic description from upstream catalog) and `use_tool` (static description, proxies calls).
- All tool names are namespaced as `<mcp-name>/<tool-name>`.
- Single upstream MCP: `dynmcp -- <command>`. Multiple upstream MCPs: config file (`mcp.json`, `.mcp.json`, or `-c <path>`).
- Config file validated at runtime via Zod; the same schema generates a published JSON Schema for editor support.

## Project Conventions

- **Language:** TypeScript (strict mode, `noUncheckedIndexedAccess`, `noUnusedLocals`)
- **Module format:** ESM (`"type": "module"` in package.json); tsup builds dual CJS+ESM output
- **Formatting/Linting:** Biome — run `npm run check` to lint and format in one pass
- **Commit style:** Conventional Commits enforced via commitlint + Husky `commit-msg` hook
- **Named exports only** — no default exports
- **No `any`** — use `unknown` for external/unvalidated data

## Critical Constraints

- All source code lives in `src/`; the entry point is `src/index.ts`
- Tests live in `tests/` mirroring `src/` structure: `src/foo/bar.ts` → `tests/foo/bar.test.ts`
- Never commit directly to `main` without passing commitlint
- `dist/` is gitignored — it is only produced by `npm run build`

## Project Structure

```
src/           # TypeScript source (entry: src/index.ts)
  config/      # Config file schema (Zod) and loader (JSON + YAML)
  proxy/       # Core proxy logic: upstream client, orchestrator, server, tool catalog
tests/         # Vitest unit tests (mirror of src/ structure)
dist/          # Build output (gitignored) — CJS + ESM + .d.ts
.husky/        # Git hooks (commit-msg runs commitlint)
tsconfig.json  # TypeScript config (strict, NodeNext modules)
tsup.config.ts # tsup build config (dual CJS+ESM, dts enabled)
vitest.config.ts # Vitest config (include: tests/**/*.test.ts)
biome.json     # Biome linter + formatter config
commitlint.config.js # Extends @commitlint/config-conventional
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Compile with tsup to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run check` | Biome lint + format (write) |
| `npm test` | Run vitest once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with v8 coverage |
