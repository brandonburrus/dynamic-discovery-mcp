import { describe, expect, it } from "vitest";
import { mcpConfigSchema } from "../../src/config/schema.js";

describe("mcpConfigSchema", () => {
  it("parses valid stdio config", () => {
    const input = {
      mcp: {
        "my-server": {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { NODE_ENV: "production" },
        },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("parses valid streamable-http config", () => {
    const input = {
      mcp: {
        "remote-api": {
          transport: "streamable-http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("parses valid sse config", () => {
    const input = {
      mcp: {
        "sse-server": {
          transport: "sse",
          url: "https://example.com/events",
        },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("parses mixed config with all 3 transport types", () => {
    const input = {
      mcp: {
        local: { transport: "stdio", command: "npx", args: ["-y", "server"] },
        remote: { transport: "streamable-http", url: "https://a.io/mcp" },
        events: { transport: "sse", url: "https://b.io/sse" },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects invalid MCP name with uppercase", () => {
    const input = {
      mcp: { MyServer: { transport: "stdio", command: "node" } },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects invalid MCP name with special chars", () => {
    const input = {
      mcp: { "my_server!": { transport: "stdio", command: "node" } },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects missing transport field", () => {
    const input = {
      mcp: { server: { command: "node" } },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects extra url field on stdio entry", () => {
    const input = {
      mcp: {
        server: {
          transport: "stdio",
          command: "node",
          url: "https://example.com",
        },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects extra command field on http entry", () => {
    const input = {
      mcp: {
        server: {
          transport: "streamable-http",
          url: "https://example.com/mcp",
          command: "node",
        },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL in streamable-http", () => {
    const input = {
      mcp: {
        server: { transport: "streamable-http", url: "not-a-url" },
      },
    };

    const result = mcpConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  describe("auth field (OAuth pre-registered credentials)", () => {
    it("accepts auth.client_id on streamable-http", () => {
      const input = {
        mcp: {
          server: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            auth: { client_id: "abc123" },
          },
        },
      };

      const result = mcpConfigSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("accepts auth.client_id + client_secret + scope on sse", () => {
      const input = {
        mcp: {
          server: {
            transport: "sse",
            url: "https://example.com/sse",
            auth: { client_id: "abc", client_secret: "shh", scope: "read write" },
          },
        },
      };

      const result = mcpConfigSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects auth on stdio entries", () => {
      const input = {
        mcp: {
          server: {
            transport: "stdio",
            command: "node",
            auth: { client_id: "abc" },
          },
        },
      };

      const result = mcpConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("rejects empty auth.client_id", () => {
      const input = {
        mcp: {
          server: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            auth: { client_id: "" },
          },
        },
      };

      const result = mcpConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("rejects whitespace-only auth.client_id", () => {
      const input = {
        mcp: {
          server: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            auth: { client_id: "   " },
          },
        },
      };

      const result = mcpConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys inside auth", () => {
      const input = {
        mcp: {
          server: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
            auth: { client_id: "abc", redirect_uri: "http://localhost" },
          },
        },
      };

      const result = mcpConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});
