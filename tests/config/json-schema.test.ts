import { describe, expect, it } from "vitest";
import { generateMcpConfigJsonSchema } from "../../src/config/json-schema.js";

describe("generateMcpConfigJsonSchema", () => {
  const schema = generateMcpConfigJsonSchema();

  it("produces a valid draft-07 JSON Schema", () => {
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.$id).toBe("https://dynamicmcp.tools/config.json");
    expect(schema.type).toBe("object");
  });

  it("includes title and description metadata", () => {
    expect(schema.title).toBe("dynmcp config");
    expect(schema.description).toContain("dynmcp");
  });

  it("requires the mcp property", () => {
    expect(schema.required).toContain("mcp");
  });

  it("allows the $schema property for editor support", () => {
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.$schema).toBeDefined();
  });

  it("enforces minProperties: 1 on the mcp map", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.mcp.minProperties).toBe(1);
  });

  it("validates MCP name pattern via propertyNames", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const propertyNames = properties.mcp.propertyNames as Record<string, unknown>;
    expect(propertyNames.pattern).toBe("^[a-z0-9][a-z0-9-]*$");
  });

  it("defines three transport variants in oneOf", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const additionalProperties = properties.mcp.additionalProperties as Record<string, unknown>;
    const oneOf = additionalProperties.oneOf as Array<Record<string, unknown>>;
    expect(oneOf).toHaveLength(3);

    const transports = oneOf.map(variant => {
      const props = variant.properties as Record<string, Record<string, unknown>>;
      return props.transport.const;
    });
    expect(transports).toContain("stdio");
    expect(transports).toContain("streamable-http");
    expect(transports).toContain("sse");
  });

  it("requires command for stdio transport", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const additionalProperties = properties.mcp.additionalProperties as Record<string, unknown>;
    const oneOf = additionalProperties.oneOf as Array<Record<string, unknown>>;
    const stdio = oneOf.find(v => {
      const props = v.properties as Record<string, Record<string, unknown>>;
      return props.transport.const === "stdio";
    });
    expect(stdio?.required).toContain("command");
  });

  it("requires url for streamable-http transport", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const additionalProperties = properties.mcp.additionalProperties as Record<string, unknown>;
    const oneOf = additionalProperties.oneOf as Array<Record<string, unknown>>;
    const http = oneOf.find(v => {
      const props = v.properties as Record<string, Record<string, unknown>>;
      return props.transport.const === "streamable-http";
    });
    expect(http?.required).toContain("url");
  });
});
