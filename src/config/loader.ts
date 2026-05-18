import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type McpConfig, mcpConfigSchema } from "./schema.js";

const AUTO_DISCOVER_NAMES = ["mcp.json", ".mcp.json"] as const;

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
 * Loads, parses, and validates the dynmcp config file.
 *
 * @param explicitPath - If provided, loads from this path. Otherwise auto-discovers.
 * @returns The validated config object.
 * @throws On missing file, parse errors, or schema validation failures.
 */
export function loadConfig(explicitPath?: string): McpConfig {
  const configPath = resolveConfigPath(explicitPath);
  const raw = readFileSync(configPath, "utf-8");

  let content: unknown;
  try {
    content = isYamlFile(configPath) ? parseYaml(raw) : JSON.parse(raw);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`Failed to parse config file (${configPath}): ${message}`);
  }

  const result = mcpConfigSchema.safeParse(content);
  if (!result.success) {
    const formatted = result.error.issues
      .map(issue => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config file (${configPath}):\n${formatted}`);
  }

  return result.data;
}

function isYamlFile(filePath: string): boolean {
  return filePath.endsWith(".yml") || filePath.endsWith(".yaml");
}
