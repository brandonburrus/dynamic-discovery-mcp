/**
 * Environment variable interpolation for dynmcp config files.
 *
 * Runs after JSON/YAML parsing but before Zod validation, so the validated
 * config contains only fully-resolved string values.
 *
 * Supported syntax (per SPEC.md "Environment Variable Interpolation"):
 *   - `${VAR}`              substitute the value of VAR; missing → error
 *   - `${VAR:-default}`     substitute VAR, or `default` if VAR is unset or empty
 *   - `$${...}`             escape — resolves to the literal `${...}`
 *
 * Interpolation applies only to leaf string values reached through the `mcp`
 * subtree. The top-level `$schema` and `env` fields are passed through verbatim.
 */

const TOP_LEVEL_PASSTHROUGH_KEYS = new Set(["$schema", "env"]);

export class MissingEnvVarsError extends Error {
  constructor(public readonly missingVars: readonly string[]) {
    const list = missingVars.join(", ");
    const plural = missingVars.length === 1 ? "" : "s";
    super(`Missing required environment variable${plural}: ${list}`);
    this.name = "MissingEnvVarsError";
  }
}

/**
 * Walks a parsed config object and substitutes `${VAR}` references in all leaf
 * string values. Top-level `$schema` and `env` keys are not interpolated.
 *
 * @param config - The parsed (but unvalidated) config object.
 * @param env - The resolved environment variable map (already merged per env mode).
 * @returns A structurally identical config with all string leaves interpolated.
 * @throws {MissingEnvVarsError} If any `${VAR}` reference has no default and no value in env.
 */
export function interpolateConfig(config: unknown, env: Record<string, string>): unknown {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }

  const missing: string[] = [];
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (TOP_LEVEL_PASSTHROUGH_KEYS.has(key)) {
      result[key] = value;
    } else {
      result[key] = walkNode(value, env, missing);
    }
  }

  if (missing.length > 0) {
    const unique = Array.from(new Set(missing)).sort();
    throw new MissingEnvVarsError(unique);
  }

  return result;
}

function walkNode(node: unknown, env: Record<string, string>, missing: string[]): unknown {
  if (typeof node === "string") {
    return interpolateString(node, env, missing);
  }
  if (Array.isArray(node)) {
    return node.map(item => walkNode(item, env, missing));
  }
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      result[key] = walkNode(value, env, missing);
    }
    return result;
  }
  return node;
}

function interpolateString(value: string, env: Record<string, string>, missing: string[]): string {
  let result = "";
  let i = 0;
  const len = value.length;

  while (i < len) {
    const ch = value[i];

    if (ch === "$" && value[i + 1] === "$" && value[i + 2] === "{") {
      // Escape: $${...} -> literal ${...} (strip one leading $)
      const close = value.indexOf("}", i + 3);
      if (close === -1) {
        // Unclosed escape; treat the leading $ as literal and advance one char
        result += ch;
        i += 1;
        continue;
      }
      result += value.substring(i + 1, close + 1);
      i = close + 1;
      continue;
    }

    if (ch === "$" && value[i + 1] === "{") {
      const close = value.indexOf("}", i + 2);
      if (close === -1) {
        // Unclosed expression; emit the rest of the string literally
        result += value.substring(i);
        break;
      }
      const expr = value.substring(i + 2, close);
      const { name, defaultValue } = parseExpr(expr);
      const resolved = env[name];
      const hasValue = resolved !== undefined && resolved !== "";

      if (hasValue) {
        result += resolved;
      } else if (defaultValue !== undefined) {
        result += defaultValue;
      } else if (resolved !== undefined) {
        // Defined but empty string and no default — treat as the empty string.
        // Per spec: ${VAR} without default fails only when VAR is *undefined*.
        result += "";
      } else {
        missing.push(name);
      }
      i = close + 1;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

function parseExpr(expr: string): { name: string; defaultValue: string | undefined } {
  const sep = expr.indexOf(":-");
  if (sep === -1) {
    return { name: expr, defaultValue: undefined };
  }
  return {
    name: expr.substring(0, sep),
    defaultValue: expr.substring(sep + 2),
  };
}
