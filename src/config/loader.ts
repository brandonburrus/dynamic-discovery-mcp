import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";
import { loadEnv } from "./env-sources.js";
import { interpolateConfig } from "./interpolate.js";
import { type EnvMode, type McpConfig, mcpConfigSchema } from "./schema.js";

const AUTO_DISCOVER_NAMES = ["mcp.json", ".mcp.json"] as const;
const DEFAULT_ENV_MODE: EnvMode = "enable";
const VALID_ENV_MODES: readonly EnvMode[] = ["enable", "dotenv", "process", "disable"];

export interface LoadConfigOptions {
  /** Path to the config file. If omitted, auto-discovers `mcp.json` then `.mcp.json` in cwd. */
  configPath?: string;
  /** Path to a custom `.env` file (from the `--env` / `-e` CLI flag). */
  envFilePath?: string;
}

/**
 * Resolves the config file path without loading or parsing it.
 *
 * @param explicitPath - If provided, resolves this path directly.
 * @returns The absolute path to the config file.
 * @throws If no config file is found at the explicit path or via auto-discovery.
 */
export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  const cwd = process.cwd();
  for (const name of AUTO_DISCOVER_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const searched = AUTO_DISCOVER_NAMES.map(n => resolve(cwd, n)).join(", ");
  throw new Error(`No config file found. Searched: ${searched}`);
}

/**
 * Loads, parses, interpolates, and validates the dynmcp config file.
 *
 * Flow: resolve path → read file → parse JSON/YAML → read env mode →
 * load env sources → interpolate `${VAR}` references → Zod validate.
 *
 * @param options - Config path and optional custom `.env` file path.
 * @returns The validated config object with all interpolations resolved.
 * @throws On missing file, parse errors, missing env vars, or schema validation failures.
 */
export function loadConfig(options: LoadConfigOptions = {}): McpConfig {
  const { configPath, envFilePath } = options;

  const resolvedPath = resolveConfigPath(configPath);
  const raw = readFileSync(resolvedPath, "utf-8");

  let content: unknown;
  try {
    content = isYamlFile(resolvedPath) ? parseYaml(raw) : JSON.parse(raw);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`Failed to parse config file (${resolvedPath}): ${message}`);
  }

  const envMode = readEnvMode(content);
  const loadedEnv = loadEnv({ mode: envMode, envFilePath });

  const interpolated = loadedEnv.interpolationEnabled
    ? interpolateConfig(content, loadedEnv.variables)
    : content;

  const result = mcpConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const formatted = result.error.issues
      .map(issue => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config file (${resolvedPath}):\n${formatted}`);
  }

  return result.data;
}

/**
 * Reads the top-level `env` field from raw parsed config content. This runs
 * before Zod validation so we can resolve env vars before validating types.
 *
 * If the field is missing, the default mode is returned. If it is present but
 * not a recognized value, the default is returned so that Zod can surface a
 * specific validation error later.
 */
function readEnvMode(content: unknown): EnvMode {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    return DEFAULT_ENV_MODE;
  }
  const value = (content as Record<string, unknown>).env;
  if (value === undefined) return DEFAULT_ENV_MODE;
  if (typeof value === "string" && (VALID_ENV_MODES as readonly string[]).includes(value)) {
    return value as EnvMode;
  }
  return DEFAULT_ENV_MODE;
}

function isYamlFile(filePath: string): boolean {
  return filePath.endsWith(".yml") || filePath.endsWith(".yaml");
}
