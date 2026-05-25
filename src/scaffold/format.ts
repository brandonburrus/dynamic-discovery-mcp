import { extname } from "node:path";

export type ConfigFileFormat = "json" | "yaml";

/**
 * Determine the file format from its path extension. `.yml` and `.yaml`
 * are treated as YAML; everything else (including `.json` and any other
 * extension) is treated as JSON. Matches the rule used by the config
 * loader so `init`/`add` and the proxy runtime stay in lockstep.
 */
export function detectFormat(filePath: string): ConfigFileFormat {
  const ext = extname(filePath).toLowerCase();
  return ext === ".yml" || ext === ".yaml" ? "yaml" : "json";
}

/** URL of the published JSON Schema served by the docs site. */
export const SCHEMA_URL = "https://dynamicmcp.tools/config.json";
