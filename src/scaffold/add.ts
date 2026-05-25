import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { type Document, parseDocument } from "yaml";
import { resolveConfigPath } from "../config/loader.js";
import { MCP_NAME_PATTERN, transportConfigSchema } from "../config/schema.js";
import { detectFormat } from "./format.js";

export type TransportKind = "stdio" | "streamable-http" | "sse";

export interface AddOptions {
  /** Name of the MCP entry to add. Must match MCP_NAME_PATTERN. */
  name: string;
  /** Transport for the new entry. */
  transport: TransportKind;
  /** Explicit config path. Otherwise auto-discovered. */
  configPath?: string;
  /** Overwrite an existing entry with the same name. Default: false. */
  force?: boolean;
  /** Per-entry description; presence makes the entry lazy (dynamic discovery). */
  description?: string;

  // stdio
  command?: string;
  args?: string[];
  /** Each entry must be `KEY=VAL`. */
  envVars?: string[];

  // streamable-http / sse
  url?: string;
  /** Each entry must be `Name: Value`. */
  headers?: string[];
  clientId?: string;
  clientSecret?: string;
  scope?: string;

  /** Override the stdout writer (for tests). */
  write?: (chunk: string) => void;
  /** Override the file reader (for tests). */
  fileReader?: (path: string) => string;
  /** Override the file writer (for tests). */
  fileWriter?: (path: string, contents: string) => void;
  /** Override the config-path resolver (for tests). */
  resolvePath?: (configPath: string | undefined) => string;
}

/**
 * Implementation of `dynmcp add`. Builds an MCP entry from the provided
 * flags, validates it against the transport discriminated-union schema,
 * and writes it back into the resolved config file. Preserves YAML
 * comments via the `yaml` library's Document API. Never interpolates
 * `${VAR}` references — they round-trip verbatim.
 */
export function add(options: AddOptions): void {
  validateName(options.name);

  const stdout = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const fileReader = options.fileReader ?? (p => readFileSync(p, "utf-8"));
  const fileWriter = options.fileWriter ?? ((p, c) => writeFileSync(p, c, "utf-8"));
  const resolvePath = options.resolvePath ?? resolveConfigPath;

  let targetPath: string;
  try {
    targetPath = resolvePath(options.configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nHint: run 'dynmcp init' to create a starter config file.`);
  }

  const raw = fileReader(targetPath);
  const format = detectFormat(targetPath);

  const entry = buildEntry(options);
  const parsed = transportConfigSchema.safeParse(entry);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid MCP entry:\n${issues}`);
  }

  const next =
    format === "yaml"
      ? writeYaml(raw, options.name, parsed.data, options.force === true)
      : writeJson(raw, options.name, parsed.data, options.force === true);

  fileWriter(targetPath, next);
  stdout(`Added '${options.name}' (${options.transport}) to ${targetPath}\n`);
}

function validateName(name: string): void {
  if (!MCP_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid MCP name '${name}'. Names must match ${MCP_NAME_PATTERN.source} ` +
        "(lowercase letters, digits, and dashes; starting with a letter or digit).",
    );
  }
}

function buildEntry(options: AddOptions): Record<string, unknown> {
  if (options.transport === "stdio") {
    if (options.command === undefined || options.command.length === 0) {
      throw new Error("--command is required for stdio transport");
    }
    const entry: Record<string, unknown> = {
      transport: "stdio",
      command: options.command,
    };
    if (options.description !== undefined) entry.description = options.description;
    if (options.args !== undefined && options.args.length > 0) {
      entry.args = options.args;
    }
    if (options.envVars !== undefined && options.envVars.length > 0) {
      entry.env = parseKeyValuePairs(options.envVars, "--env");
    }
    return entry;
  }

  if (options.url === undefined || options.url.length === 0) {
    throw new Error(`--url is required for ${options.transport} transport`);
  }
  const entry: Record<string, unknown> = {
    transport: options.transport,
    url: options.url,
  };
  if (options.description !== undefined) entry.description = options.description;
  if (options.headers !== undefined && options.headers.length > 0) {
    entry.headers = parseHeaderPairs(options.headers);
  }
  const auth = buildAuthBlock(options);
  if (auth !== undefined) entry.auth = auth;
  return entry;
}

function buildAuthBlock(options: AddOptions): Record<string, string> | undefined {
  const hasAny =
    options.clientId !== undefined ||
    options.clientSecret !== undefined ||
    options.scope !== undefined;
  if (!hasAny) return undefined;

  if (options.clientId === undefined) {
    throw new Error("--client-id is required when --client-secret or --scope is provided");
  }
  const auth: Record<string, string> = { client_id: options.clientId };
  if (options.clientSecret !== undefined) auth.client_secret = options.clientSecret;
  if (options.scope !== undefined) auth.scope = options.scope;
  return auth;
}

function parseKeyValuePairs(pairs: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${flag} expects KEY=VALUE (got: ${JSON.stringify(pair)})`);
    }
    const key = pair.slice(0, eq);
    out[key] = pair.slice(eq + 1);
  }
  return out;
}

function parseHeaderPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const colon = pair.indexOf(":");
    if (colon <= 0) {
      throw new Error(`--header expects "Name: Value" (got: ${JSON.stringify(pair)})`);
    }
    const key = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim();
    if (key.length === 0) {
      throw new Error(`--header name cannot be empty (got: ${JSON.stringify(pair)})`);
    }
    out[key] = value;
  }
  return out;
}

function writeJson(raw: string, name: string, entry: unknown, force: boolean): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config as JSON: ${message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Top-level config must be a JSON object.");
  }
  let mcp = parsed.mcp;
  if (mcp === undefined) {
    mcp = {};
    parsed.mcp = mcp;
  } else if (!isPlainObject(mcp)) {
    throw new Error("Config field 'mcp' must be an object.");
  }
  const mcpRecord = mcp as Record<string, unknown>;
  if (mcpRecord[name] !== undefined && !force) {
    throw new Error(`Entry '${name}' already exists. Use --force to overwrite.`);
  }
  mcpRecord[name] = entry;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function writeYaml(raw: string, name: string, entry: unknown, force: boolean): string {
  const doc: Document = parseDocument(raw);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message ?? "unknown error";
    throw new Error(`Failed to parse config as YAML: ${first}`);
  }
  if (!doc.has("mcp")) {
    doc.set("mcp", {});
  }
  const path: [string, string] = ["mcp", name];
  if (doc.hasIn(path) && !force) {
    throw new Error(`Entry '${name}' already exists. Use --force to overwrite.`);
  }
  doc.setIn(path, entry);
  return doc.toString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
