import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { EnvMode } from "./schema.js";

const DEFAULT_DOTENV_FILENAME = ".env";

export interface LoadEnvOptions {
  /** Env interpolation mode (from config file top-level `env` field). */
  mode: EnvMode;
  /** Custom `.env` path from the `--env` / `-e` CLI flag. When provided, the file must exist. */
  envFilePath?: string;
  /** Override for cwd (testability). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override for process.env (testability). Defaults to `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
}

export interface LoadedEnv {
  /** Merged variable map ready for interpolation. */
  variables: Record<string, string>;
  /** Whether interpolation should run at all. False only when mode is "disable". */
  interpolationEnabled: boolean;
}

/**
 * Resolves the environment variable map used for config interpolation.
 *
 * Precedence rules:
 *   - mode "enable":  load .env + process.env, .env wins for duplicates.
 *   - mode "dotenv":  load .env only; process.env is ignored.
 *   - mode "process": process.env only; no .env file is loaded.
 *   - mode "disable": no sources; interpolation is turned off.
 *
 * The `--env` flag is incompatible with "disable" and "process" modes and is
 * rejected at startup as an incoherent combination.
 *
 * @throws If `--env` is combined with an incompatible mode.
 * @throws If an explicit `--env` path does not exist or cannot be parsed.
 */
export function loadEnv(options: LoadEnvOptions): LoadedEnv {
  const { mode, envFilePath, cwd = process.cwd(), processEnv = process.env } = options;

  if (envFilePath !== undefined && (mode === "disable" || mode === "process")) {
    throw new Error(
      `--env flag is incompatible with env mode "${mode}". --env requires env mode "enable" or "dotenv".`,
    );
  }

  if (mode === "disable") {
    return { variables: {}, interpolationEnabled: false };
  }

  const dotenvVars = mode === "process" ? {} : readDotenvFile(envFilePath, cwd);
  const processVars = mode === "dotenv" ? {} : filterDefined(processEnv);

  // For "enable" mode, .env wins (later spread overrides earlier).
  // For "process" and "dotenv" modes only one source is non-empty, so order is moot.
  const variables = { ...processVars, ...dotenvVars };

  return { variables, interpolationEnabled: true };
}

function readDotenvFile(envFilePath: string | undefined, cwd: string): Record<string, string> {
  const isExplicit = envFilePath !== undefined;
  const resolvedPath = isExplicit
    ? resolve(envFilePath as string)
    : resolve(cwd, DEFAULT_DOTENV_FILENAME);

  if (!existsSync(resolvedPath)) {
    if (isExplicit) {
      throw new Error(`.env file not found: ${resolvedPath}`);
    }
    // Soft-fail: a missing default .env is not an error.
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (readError) {
    const message = readError instanceof Error ? readError.message : String(readError);
    throw new Error(`Failed to read .env file (${resolvedPath}): ${message}`);
  }

  try {
    return dotenv.parse(raw);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`Failed to parse .env file (${resolvedPath}): ${message}`);
  }
}

function filterDefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
