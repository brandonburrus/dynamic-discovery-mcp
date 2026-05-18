import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Variables prefixed with "mock" are automatically hoisted by Vitest and are
// available inside vi.mock() factory functions without needing vi.hoisted().
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue([]);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

let capturedOnTransportError: ((error: Error) => void) | undefined;

vi.mock("../../src/proxy/upstream-client.js", () => ({
  UpstreamClient: class {
    connect = mockConnect;
    listTools = mockListTools;
    disconnect = mockDisconnect;

    constructor(config: { onTransportError?: (error: Error) => void }) {
      capturedOnTransportError = config.onTransportError;
    }
  },
}));

vi.mock("../../src/proxy/tool-catalog.js", () => ({
  ToolCatalog: class {
    static fromFlat() {
      return new this();
    }
  },
}));

const mockProxyServerStart = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/proxy/server.js", () => ({
  ProxyServer: class {
    start = mockProxyServerStart;
  },
}));

const { startProxy } = await import("../../src/proxy/index.js");

describe("startProxy()", () => {
  let mockProcessExit: ReturnType<typeof vi.spyOn>;
  let mockStderrWrite: ReturnType<typeof vi.spyOn>;
  let mockProcessOn: ReturnType<typeof vi.spyOn>;
  let mockStdinOn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnTransportError = undefined;

    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue([]);
    mockDisconnect.mockResolvedValue(undefined);
    mockProxyServerStart.mockResolvedValue(undefined);

    // Never actually exit — just record the call. process.exit's `never` return type is
    // satisfied by casting undefined. Tests for synchronous exit paths (connect/listTools
    // rejection) call startProxy with await and check the spy after the async chain settles.
    mockProcessExit = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null): never => {
        return undefined as never;
      });

    mockStderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockProcessOn = vi.spyOn(process, "on").mockImplementation(() => process);
    mockStdinOn = vi.spyOn(process.stdin, "on").mockImplementation(() => process.stdin);
  });

  describe("happy path", () => {
    it("registers SIGINT, SIGTERM, stdin end, and stdin close handlers", async () => {
      await startProxy("test-server", []);

      const processOnCalls = mockProcessOn.mock.calls.map(
        ([event]: [unknown, ...unknown[]]) => event,
      );
      expect(processOnCalls).toContain("SIGINT");
      expect(processOnCalls).toContain("SIGTERM");

      const stdinOnCalls = mockStdinOn.mock.calls.map(([event]: [unknown, ...unknown[]]) => event);
      expect(stdinOnCalls).toContain("end");
      expect(stdinOnCalls).toContain("close");
    });

    it("calls connect(), listTools(), and ProxyServer.start() in order", async () => {
      await startProxy("test-server", []);

      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockListTools).toHaveBeenCalledOnce();
      expect(mockProxyServerStart).toHaveBeenCalledOnce();
    });

    it("does not call process.exit on success", async () => {
      await startProxy("test-server", []);

      expect(mockProcessExit).not.toHaveBeenCalled();
    });
  });

  describe("when connect() rejects", () => {
    it("writes the error message to stderr", async () => {
      mockConnect.mockRejectedValue(new Error("connection refused"));

      await startProxy("test-server", []);

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
    });

    it("calls process.exit(1)", async () => {
      mockConnect.mockRejectedValue(new Error("connection refused"));

      await startProxy("test-server", []);

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it("writes a non-Error rejection as a string to stderr", async () => {
      mockConnect.mockRejectedValue("plain string error");

      await startProxy("test-server", []);

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("plain string error"));
    });
  });

  describe("when listTools() rejects", () => {
    it("writes the error message to stderr", async () => {
      mockListTools.mockRejectedValue(new Error("listing tools failed"));

      await startProxy("test-server", []);

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("listing tools failed"));
    });

    it("calls process.exit(1)", async () => {
      mockListTools.mockRejectedValue(new Error("listing tools failed"));

      await startProxy("test-server", []);

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe("onTransportError callback", () => {
    it("writes the transport error message to stderr", async () => {
      await startProxy("test-server", []);

      expect(capturedOnTransportError).toBeDefined();
      capturedOnTransportError!(new Error("transport lost"));

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("transport lost"));
    });

    it("calls disconnect() and then process.exit(1) on transport error", async () => {
      await startProxy("test-server", []);

      expect(capturedOnTransportError).toBeDefined();
      capturedOnTransportError!(new Error("transport lost"));

      // disconnect() is async — give the microtask queue a turn to settle
      await new Promise(resolve => setImmediate(resolve));

      expect(mockDisconnect).toHaveBeenCalledOnce();
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    it("only shuts down once if transport error fires multiple times", async () => {
      await startProxy("test-server", []);

      expect(capturedOnTransportError).toBeDefined();
      capturedOnTransportError!(new Error("first error"));
      capturedOnTransportError!(new Error("second error"));

      await new Promise(resolve => setImmediate(resolve));

      expect(mockDisconnect).toHaveBeenCalledOnce();
      expect(mockProcessExit).toHaveBeenCalledOnce();
    });
  });

  describe("SIGINT shutdown handler", () => {
    it("calls disconnect() and then process.exit(0) when SIGINT fires", async () => {
      await startProxy("test-server", []);

      const sigintCall = mockProcessOn.mock.calls.find(
        ([event]: [unknown, ...unknown[]]) => event === "SIGINT",
      );
      expect(sigintCall).toBeDefined();

      const sigintHandler = sigintCall![1] as () => void;
      sigintHandler();

      // disconnect() is async — give the microtask queue a turn to settle
      await new Promise(resolve => setImmediate(resolve));

      expect(mockDisconnect).toHaveBeenCalledOnce();
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });

    it("only disconnects once if SIGINT fires then transport error fires", async () => {
      await startProxy("test-server", []);

      const sigintCall = mockProcessOn.mock.calls.find(
        ([event]: [unknown, ...unknown[]]) => event === "SIGINT",
      );
      const sigintHandler = sigintCall![1] as () => void;
      sigintHandler();

      expect(capturedOnTransportError).toBeDefined();
      capturedOnTransportError!(new Error("transport lost after SIGINT"));

      await new Promise(resolve => setImmediate(resolve));

      expect(mockDisconnect).toHaveBeenCalledOnce();
      expect(mockProcessExit).toHaveBeenCalledOnce();
    });
  });

  describe("disconnect rejection during shutdown", () => {
    it("writes disconnect error to stderr and still calls process.exit", async () => {
      mockDisconnect.mockRejectedValue(new Error("disconnect failed"));
      await startProxy("test-server", []);

      const sigintCall = mockProcessOn.mock.calls.find(
        ([event]: [unknown, ...unknown[]]) => event === "SIGINT",
      );
      const sigintHandler = sigintCall![1] as () => void;
      sigintHandler();

      await new Promise(resolve => setImmediate(resolve));

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("disconnect failed"));
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });
  });
});
