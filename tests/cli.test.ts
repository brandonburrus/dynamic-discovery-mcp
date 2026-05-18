import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Variables prefixed with "mock" are automatically hoisted by Vitest and are
// available inside vi.mock() factory functions without needing vi.hoisted().
const mockStartProxy = vi.fn().mockResolvedValue(undefined);

vi.mock("figlet", () => ({
  default: {
    textSync: () => "DYNAMIC MCP",
  },
}));

vi.mock("chalk", () => ({
  default: {
    bold: {
      magentaBright: (s: string) => s,
    },
  },
}));

vi.mock("../src/proxy/index.js", () => ({
  startProxy: mockStartProxy,
}));

const { cli } = await import("../src/cli.js");

describe("cli", () => {
  let mockProcessExit: ReturnType<typeof vi.spyOn>;
  let mockStderrWrite: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartProxy.mockResolvedValue(undefined);

    mockProcessExit = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null): never => {
        throw new Error(`process.exit(${code})`);
      });

    mockStderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe("when -- is not present in process.argv", () => {
    it("writes the usage error to stderr", async () => {
      process.argv = ["node", "dynamic-mcp"];

      await expect(cli.parseAsync(["node", "dynamic-mcp"])).rejects.toThrow("process.exit(1)");

      expect(mockStderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("no upstream command provided"),
      );
    });

    it("calls process.exit(1)", async () => {
      process.argv = ["node", "dynamic-mcp"];

      await expect(cli.parseAsync(["node", "dynamic-mcp"])).rejects.toThrow("process.exit(1)");

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe("when -- is present but no command follows", () => {
    it("writes the usage error to stderr", async () => {
      process.argv = ["node", "dynamic-mcp", "--"];

      await expect(cli.parseAsync(["node", "dynamic-mcp", "--"])).rejects.toThrow(
        "process.exit(1)",
      );

      expect(mockStderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("no upstream command provided"),
      );
    });

    it("calls process.exit(1)", async () => {
      process.argv = ["node", "dynamic-mcp", "--"];

      await expect(cli.parseAsync(["node", "dynamic-mcp", "--"])).rejects.toThrow(
        "process.exit(1)",
      );

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe("when a valid command is provided after --", () => {
    it("calls startProxy with the command and an empty args array", async () => {
      process.argv = ["node", "dynamic-mcp", "--", "npx", "chrome-devtools-mcp"];

      await cli.parseAsync(["node", "dynamic-mcp", "--", "npx", "chrome-devtools-mcp"]);

      expect(mockStartProxy).toHaveBeenCalledWith("npx", ["chrome-devtools-mcp"]);
    });

    it("calls startProxy with the command and all subsequent args", async () => {
      process.argv = ["node", "dynamic-mcp", "--", "npx", "-y", "chrome-devtools-mcp@latest"];

      await cli.parseAsync([
        "node",
        "dynamic-mcp",
        "--",
        "npx",
        "-y",
        "chrome-devtools-mcp@latest",
      ]);

      expect(mockStartProxy).toHaveBeenCalledWith("npx", ["-y", "chrome-devtools-mcp@latest"]);
    });
  });

  describe("when startProxy rejects", () => {
    it("writes the error message to stderr", async () => {
      mockStartProxy.mockRejectedValue(new Error("connection failed"));
      process.argv = ["node", "dynamic-mcp", "--", "npx", "chrome-devtools-mcp"];

      await expect(
        cli.parseAsync(["node", "dynamic-mcp", "--", "npx", "chrome-devtools-mcp"]),
      ).rejects.toThrow("process.exit(1)");

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("connection failed"));
    });

    it("calls process.exit(1)", async () => {
      mockStartProxy.mockRejectedValue(new Error("connection failed"));
      process.argv = ["node", "dynamic-mcp", "--", "npx", "chrome-devtools-mcp"];

      await expect(
        cli.parseAsync(["node", "dynamic-mcp", "--", "npx", "chrome-devtools-mcp"]),
      ).rejects.toThrow("process.exit(1)");

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });
});
