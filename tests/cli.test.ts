import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Variables prefixed with "mock" are automatically hoisted by Vitest and are
// available inside vi.mock() factory functions without needing vi.hoisted().
const mockStartProxy = vi.fn().mockResolvedValue(undefined);
const mockStartProxyFromConfig = vi.fn().mockResolvedValue(undefined);

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
  startProxyFromConfig: mockStartProxyFromConfig,
}));

const { cli } = await import("../src/cli.js");

describe("cli", () => {
  let mockProcessExit: ReturnType<typeof vi.spyOn>;
  let mockStderrWrite: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartProxy.mockResolvedValue(undefined);
    mockStartProxyFromConfig.mockResolvedValue(undefined);

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

  describe("when -- is not present in process.argv (config file mode)", () => {
    it("calls startProxyFromConfig with undefined (auto-discover)", async () => {
      process.argv = ["node", "dynmcp"];

      await cli.parseAsync(["node", "dynmcp"]);

      expect(mockStartProxyFromConfig).toHaveBeenCalledWith({
        configPath: undefined,
        envFilePath: undefined,
      });
    });

    it("calls startProxyFromConfig with the explicit config path when -c is provided", async () => {
      process.argv = ["node", "dynmcp", "-c", "./my-config.json"];

      await cli.parseAsync(["node", "dynmcp", "-c", "./my-config.json"]);

      expect(mockStartProxyFromConfig).toHaveBeenCalledWith({
        configPath: "./my-config.json",
        envFilePath: undefined,
      });
    });

    it("passes the custom .env path when -e is provided", async () => {
      process.argv = ["node", "dynmcp", "-e", "./custom.env"];

      await cli.parseAsync(["node", "dynmcp", "-e", "./custom.env"]);

      expect(mockStartProxyFromConfig).toHaveBeenCalledWith({
        configPath: undefined,
        envFilePath: "./custom.env",
      });
    });

    it("passes the custom .env path when --env is provided", async () => {
      process.argv = ["node", "dynmcp", "--env", "./custom.env"];

      await cli.parseAsync(["node", "dynmcp", "--env", "./custom.env"]);

      expect(mockStartProxyFromConfig).toHaveBeenCalledWith({
        configPath: undefined,
        envFilePath: "./custom.env",
      });
    });

    it("passes both --config and --env together", async () => {
      process.argv = ["node", "dynmcp", "-c", "./mcp.json", "-e", "./.env.local"];

      await cli.parseAsync(["node", "dynmcp", "-c", "./mcp.json", "-e", "./.env.local"]);

      expect(mockStartProxyFromConfig).toHaveBeenCalledWith({
        configPath: "./mcp.json",
        envFilePath: "./.env.local",
      });
    });

    it("writes error to stderr and exits when startProxyFromConfig rejects", async () => {
      mockStartProxyFromConfig.mockRejectedValue(new Error("No config file found"));
      process.argv = ["node", "dynmcp"];

      await expect(cli.parseAsync(["node", "dynmcp"])).rejects.toThrow("process.exit(1)");

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("No config file found"));
      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe("when -- is present but no command follows", () => {
    it("writes the usage error to stderr", async () => {
      process.argv = ["node", "dynmcp", "--"];

      await expect(cli.parseAsync(["node", "dynmcp", "--"])).rejects.toThrow("process.exit(1)");

      expect(mockStderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("no upstream command provided"),
      );
    });

    it("calls process.exit(1)", async () => {
      process.argv = ["node", "dynmcp", "--"];

      await expect(cli.parseAsync(["node", "dynmcp", "--"])).rejects.toThrow("process.exit(1)");

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });

  describe("when a valid command is provided after --", () => {
    it("calls startProxy with the command and an empty args array", async () => {
      process.argv = ["node", "dynmcp", "--", "npx", "chrome-devtools-mcp"];

      await cli.parseAsync(["node", "dynmcp", "--", "npx", "chrome-devtools-mcp"]);

      expect(mockStartProxy).toHaveBeenCalledWith("npx", ["chrome-devtools-mcp"]);
    });

    it("calls startProxy with the command and all subsequent args", async () => {
      process.argv = ["node", "dynmcp", "--", "npx", "-y", "chrome-devtools-mcp@latest"];

      await cli.parseAsync(["node", "dynmcp", "--", "npx", "-y", "chrome-devtools-mcp@latest"]);

      expect(mockStartProxy).toHaveBeenCalledWith("npx", ["-y", "chrome-devtools-mcp@latest"]);
    });
  });

  describe("when startProxy rejects", () => {
    it("writes the error message to stderr", async () => {
      mockStartProxy.mockRejectedValue(new Error("connection failed"));
      process.argv = ["node", "dynmcp", "--", "npx", "chrome-devtools-mcp"];

      await expect(
        cli.parseAsync(["node", "dynmcp", "--", "npx", "chrome-devtools-mcp"]),
      ).rejects.toThrow("process.exit(1)");

      expect(mockStderrWrite).toHaveBeenCalledWith(expect.stringContaining("connection failed"));
    });

    it("calls process.exit(1)", async () => {
      mockStartProxy.mockRejectedValue(new Error("connection failed"));
      process.argv = ["node", "dynmcp", "--", "npx", "chrome-devtools-mcp"];

      await expect(
        cli.parseAsync(["node", "dynmcp", "--", "npx", "chrome-devtools-mcp"]),
      ).rejects.toThrow("process.exit(1)");

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
  });
});
