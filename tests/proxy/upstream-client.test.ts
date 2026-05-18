import { beforeEach, describe, expect, it, vi } from "vitest";

// Variables prefixed with "mock" are automatically hoisted by Vitest and are
// available inside vi.mock() factory functions without needing vi.hoisted().
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // A class is a proper constructor — arrow/regular functions returned from
  // mockImplementation() are not guaranteed to work with `new`.
  Client: class {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
  },
}));

const { UpstreamClient } = await import("../../src/proxy/upstream-client.js");

function createMockTransport() {
  return {
    onerror: undefined,
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildConnectedClient(): Promise<InstanceType<typeof UpstreamClient>> {
  const client = new UpstreamClient({ name: "test-server", transport: createMockTransport() });
  await client.connect();
  return client;
}

describe("UpstreamClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  describe("listTools()", () => {
    it("returns an array of UpstreamTool with correct name, description, and inputSchema", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_navigate",
            description: "Navigate the browser to a URL",
            inputSchema: { type: "object", properties: { url: { type: "string" } } },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: "browser_navigate",
        description: "Navigate the browser to a URL",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
      });
    });

    it("includes outputSchema when the SDK response contains it", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_screenshot",
            description: "Take a screenshot",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { data: { type: "string" } } },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools[0]?.outputSchema).toEqual({
        type: "object",
        properties: { data: { type: "string" } },
      });
    });

    it("includes annotations with all five fields when the SDK response contains them", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_click",
            description: "Click an element",
            inputSchema: { type: "object" },
            annotations: {
              title: "Browser Click",
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools[0]?.annotations).toEqual({
        title: "Browser Click",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    });

    it("omits outputSchema and annotations when they are absent from the SDK response", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "browser_navigate",
            description: "Navigate the browser to a URL",
            inputSchema: { type: "object" },
          },
        ],
      });

      const client = await buildConnectedClient();
      const tools = await client.listTools();

      expect(tools[0]).not.toHaveProperty("outputSchema");
      expect(tools[0]).not.toHaveProperty("annotations");
    });
  });

  describe("callTool()", () => {
    it("calls the SDK client's callTool with the correct name and arguments", async () => {
      const expectedResult = { content: [{ type: "text", text: "done" }] };
      mockCallTool.mockResolvedValue(expectedResult);

      const client = await buildConnectedClient();
      await client.callTool("browser_navigate", { url: "https://example.com" });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      });
    });

    it("returns the full result from the SDK client", async () => {
      const expectedResult = {
        content: [{ type: "text", text: "Navigation complete" }],
        isError: false,
      };
      mockCallTool.mockResolvedValue(expectedResult);

      const client = await buildConnectedClient();
      const result = await client.callTool("browser_navigate", { url: "https://example.com" });

      expect(result).toEqual(expectedResult);
    });
  });
});
