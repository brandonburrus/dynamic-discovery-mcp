import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createTransport } from "../../src/proxy/transport-factory.js";

describe("createTransport", () => {
  describe("stdio", () => {
    it("constructs a StdioClientTransport with the command", () => {
      const transport = createTransport("test", {
        transport: "stdio",
        command: "echo",
      });
      expect(transport).toBeInstanceOf(StdioClientTransport);
    });

    it("accepts args and env in the stdio config", () => {
      const transport = createTransport("test", {
        transport: "stdio",
        command: "echo",
        args: ["hello", "world"],
        env: { FOO: "bar" },
      });
      expect(transport).toBeInstanceOf(StdioClientTransport);
    });
  });

  describe("streamable-http", () => {
    it("constructs a StreamableHTTPClientTransport with the URL", () => {
      const transport = createTransport("test", {
        transport: "streamable-http",
        url: "https://example.com/mcp",
      });
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    });

    it("accepts headers in the streamable-http config", () => {
      const transport = createTransport("test", {
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      });
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    });

    it("accepts a pre-registered OAuth client_id via auth config", () => {
      const transport = createTransport("test", {
        transport: "streamable-http",
        url: "https://example.com/mcp",
        auth: { client_id: "pre-registered-id" },
      });
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    });
  });

  describe("sse", () => {
    it("constructs an SSEClientTransport with the URL", () => {
      const transport = createTransport("test", {
        transport: "sse",
        url: "https://example.com/sse",
      });
      expect(transport).toBeInstanceOf(SSEClientTransport);
    });

    it("accepts headers in the sse config", () => {
      const transport = createTransport("test", {
        transport: "sse",
        url: "https://example.com/sse",
        headers: { Authorization: "Bearer token" },
      });
      expect(transport).toBeInstanceOf(SSEClientTransport);
    });
  });
});
