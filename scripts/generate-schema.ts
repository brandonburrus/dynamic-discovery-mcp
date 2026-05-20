import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMcpConfigJsonSchema } from "../src/config/json-schema.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

// The schema is written to the docs site's public directory so it can be served
// at https://dynamicmcp.tools/config.json — the canonical $id baked into the
// schema. This file is the single distribution channel for the schema; the npm
// tarball no longer ships its own copy.
const outputPath = resolve(projectRoot, "docs", "public", "config.json");

const schema = generateMcpConfigJsonSchema();
const json = `${JSON.stringify(schema, null, 2)}\n`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, json, "utf-8");

const relPath = outputPath.replace(`${projectRoot}/`, "");
console.log(`Wrote JSON Schema to ${relPath}`);
