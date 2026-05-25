import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { detectFormat, SCHEMA_URL } from "./format.js";

export interface InitOptions {
  /** Explicit target file path (relative to cwd or absolute). Extension determines format. */
  path?: string;
  /** Shortcut: write `mcp.yaml` instead of `mcp.json`. Ignored if `path` is set. */
  yaml?: boolean;
  /** Overwrite an existing file. Default: false. */
  force?: boolean;
  /** Override the current working directory (for tests). */
  cwd?: string;
  /** Override the stdout writer (for tests). */
  write?: (chunk: string) => void;
  /** Override the file writer (for tests). */
  fileWriter?: (path: string, contents: string) => void;
  /** Override the existence check (for tests). */
  fileExists?: (path: string) => boolean;
}

/**
 * Implementation of `dynmcp init`. Writes a starter config file at the
 * resolved path. The written file has `$schema` set and an empty `mcp`
 * map; it is intentionally not yet runtime-valid (the Zod schema requires
 * `mcp` to be non-empty). The next `dynmcp add` makes it valid.
 */
export function init(options: InitOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const fileWriter = options.fileWriter ?? ((p, c) => writeFileSync(p, c, "utf-8"));
  const fileExists = options.fileExists ?? (p => existsSync(p));

  const targetPath = resolveInitPath({ cwd, path: options.path, yaml: options.yaml === true });
  const format = detectFormat(targetPath);

  if (fileExists(targetPath) && options.force !== true) {
    throw new Error(`File already exists: ${targetPath}\nUse --force to overwrite.`);
  }

  const contents = format === "yaml" ? renderYamlSkeleton() : renderJsonSkeleton();
  fileWriter(targetPath, contents);

  stdout(`Wrote ${targetPath}\n`);
  stdout("\nThis config has no MCPs yet. Add one with:\n");
  stdout("  dynmcp add <name> --command <cmd>                          (stdio upstream)\n");
  stdout("  dynmcp add <name> --transport streamable-http --url <url>  (remote HTTP upstream)\n");
  stdout("\nSee https://dynamicmcp.tools for full documentation.\n");
}

function resolveInitPath(opts: { cwd: string; path: string | undefined; yaml: boolean }): string {
  if (opts.path !== undefined) {
    return resolve(opts.cwd, opts.path);
  }
  return resolve(opts.cwd, opts.yaml ? "mcp.yaml" : "mcp.json");
}

function renderJsonSkeleton(): string {
  const body = JSON.stringify({ $schema: SCHEMA_URL, mcp: {} }, null, 2);
  return `${body}\n`;
}

function renderYamlSkeleton(): string {
  return `# yaml-language-server: $schema=${SCHEMA_URL}\n\nmcp: {}\n`;
}
