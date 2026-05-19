import { z } from "zod";
import { mcpConfigSchema } from "./schema.js";

export const MCP_CONFIG_SCHEMA_ID = "https://unpkg.com/dynmcp/schema/mcp-config.json";
export const MCP_CONFIG_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

/**
 * Generates the JSON Schema for the dynmcp config file from the runtime Zod schema.
 *
 * The schema is targeted at JSON Schema draft-07 for the broadest editor support
 * (VS Code, JetBrains, and the JSON Schema Store all consume draft-07 reliably).
 *
 * @returns A JSON Schema document describing the dynmcp config file format.
 */
export function generateMcpConfigJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(mcpConfigSchema, {
    target: "draft-7",
  }) as Record<string, unknown>;

  const properties = (generated.properties ?? {}) as Record<string, unknown>;
  const mcpProperty = (properties.mcp ?? {}) as Record<string, unknown>;

  return {
    $schema: MCP_CONFIG_SCHEMA_DRAFT,
    $id: MCP_CONFIG_SCHEMA_ID,
    title: "dynmcp config",
    description:
      "Configuration file for dynmcp. Declares the set of upstream MCPs to proxy through dynamic-discovery-mcp.",
    ...generated,
    properties: {
      ...properties,
      $schema: {
        type: "string",
        description: "URL of the JSON Schema for editor validation.",
      },
      mcp: {
        ...mcpProperty,
        minProperties: 1,
        description:
          "Map of upstream MCPs to proxy, keyed by MCP name. Each name becomes the namespace prefix for that MCP's tools.",
      },
    },
  };
}
