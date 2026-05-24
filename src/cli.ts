import process from "node:process";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import figlet from "figlet";
import chalk from "chalk";
import { login, logout } from "./auth/index.js";
import { list, test } from "./diagnostics/index.js";
import { startProxy, startProxyFromConfig } from "./proxy/index.js";

const cliBanner = chalk.bold.magentaBright(
  figlet.textSync("DYNAMIC MCP", {
    font: "Sub-Zero",
    horizontalLayout: "fitted",
    verticalLayout: "fitted",
  }),
);

export const cli = new Command(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version)
  .addHelpText("beforeAll", cliBanner)
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  dynmcp -- npx -y chrome-devtools-mcp@latest\n" +
      "  dynmcp --config ./mcp.json\n" +
      "  dynmcp ls\n" +
      "  dynmcp test github\n" +
      "  dynmcp login github\n" +
      "  dynmcp logout github\n",
  )
  .option("-c, --config <path>", "Path to config file (JSON or YAML)")
  .option("-e, --env <path>", "Path to a .env file for environment variable interpolation")
  .allowExcessArguments(true)
  .passThroughOptions(true)
  .action(async (_options, cmd) => {
    const separatorIndex = process.argv.indexOf("--");
    const configPath = cmd.opts().config as string | undefined;
    const envFilePath = cmd.opts().env as string | undefined;

    if (separatorIndex !== -1) {
      const [command, ...args] = process.argv.slice(separatorIndex + 1);

      if (command === undefined) {
        process.stderr.write(
          "dynmcp: no upstream command provided after --.\n" +
            "Usage: dynmcp -- <command> [args...]\n",
        );
        process.exit(1);
      }

      try {
        await startProxy(command, args);
      } catch (error) {
        process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
      return;
    }

    try {
      await startProxyFromConfig({ configPath, envFilePath });
    } catch (error) {
      process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

cli
  .command("login <name>")
  .description("Run the OAuth authorization-code flow for an upstream MCP and store tokens.")
  .option("-c, --config <path>", "Path to config file (JSON or YAML)")
  .option("-e, --env <path>", "Path to a .env file for environment variable interpolation")
  .action(async (name: string, options: { config?: string; env?: string }) => {
    try {
      await login({
        mcpName: name,
        ...(options.config !== undefined ? { configPath: options.config } : {}),
        ...(options.env !== undefined ? { envFilePath: options.env } : {}),
      });
    } catch (error) {
      process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

cli
  .command("logout <name>")
  .description("Delete the OAuth keychain entry for an upstream MCP.")
  .option("-c, --config <path>", "Path to config file (JSON or YAML)")
  .option("-e, --env <path>", "Path to a .env file for environment variable interpolation")
  .action(async (name: string, options: { config?: string; env?: string }) => {
    try {
      await logout({
        mcpName: name,
        ...(options.config !== undefined ? { configPath: options.config } : {}),
        ...(options.env !== undefined ? { envFilePath: options.env } : {}),
      });
    } catch (error) {
      process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

cli
  .command("ls")
  .description("List configured upstream MCPs with transport, mode, endpoint, and auth status.")
  .option("-c, --config <path>", "Path to config file (JSON or YAML)")
  .option("-e, --env <path>", "Path to a .env file for environment variable interpolation")
  .option("--json", "Emit JSON instead of the aligned text table")
  .action(async (options: { config?: string; env?: string; json?: boolean }) => {
    try {
      await list({
        ...(options.config !== undefined ? { configPath: options.config } : {}),
        ...(options.env !== undefined ? { envFilePath: options.env } : {}),
        ...(options.json === true ? { json: true } : {}),
      });
    } catch (error) {
      process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

cli
  .command("test [name]")
  .description("Probe one or all configured upstream MCPs and print their discovered catalogs.")
  .option("-c, --config <path>", "Path to config file (JSON or YAML)")
  .option("-e, --env <path>", "Path to a .env file for environment variable interpolation")
  .option("--json", "Emit JSON instead of the formatted text output")
  .option("--timeout <ms>", "Per-MCP timeout in milliseconds (default: 15000)", v => Number(v))
  .action(
    async (
      name: string | undefined,
      options: { config?: string; env?: string; json?: boolean; timeout?: number },
    ) => {
      try {
        const exitCode = await test({
          ...(name !== undefined ? { mcpName: name } : {}),
          ...(options.config !== undefined ? { configPath: options.config } : {}),
          ...(options.env !== undefined ? { envFilePath: options.env } : {}),
          ...(options.json === true ? { json: true } : {}),
          ...(options.timeout !== undefined && !Number.isNaN(options.timeout)
            ? { timeoutMs: options.timeout }
            : {}),
        });
        if (exitCode !== 0) process.exit(exitCode);
      } catch (error) {
        process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    },
  );
