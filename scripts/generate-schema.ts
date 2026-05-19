import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMcpConfigJsonSchema } from "../src/config/json-schema.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const outputPath = resolve(projectRoot, "schema", "mcp-config.json");

mkdirSync(dirname(outputPath), { recursive: true });

const schema = generateMcpConfigJsonSchema();
const json = `${JSON.stringify(schema, null, 2)}\n`;
writeFileSync(outputPath, json, "utf-8");

const relPath = outputPath.replace(`${projectRoot}/`, "");
console.log(`Wrote JSON Schema to ${relPath}`);
