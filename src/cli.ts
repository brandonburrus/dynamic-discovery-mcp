import process from "node:process";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import figlet from "figlet";
import chalk from "chalk";
import { login, logout } from "./auth/index.js";
import { list, test } from "./diagnostics/index.js";
import { startProxy, startProxyFromConfig } from "./proxy/index.js";
import { add, init, type TransportKind } from "./scaffold/index.js";

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
      "  dynmcp init\n" +
      "  dynmcp add filesystem --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp\n" +
      "  dynmcp add github --transport streamable-http --url https://api.githubcopilot.com/mcp\n" +
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
  .command("init")
  .description("Write a starter config file (mcp.json by default) in the current directory.")
  .option("--path <path>", "Explicit target path (extension determines format).")
  .option("--yaml", "Write mcp.yaml instead of mcp.json (ignored if --path is set).")
  .option("--force", "Overwrite an existing file.")
  .action((options: { path?: string; yaml?: boolean; force?: boolean }) => {
    try {
      init({
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.yaml === true ? { yaml: true } : {}),
        ...(options.force === true ? { force: true } : {}),
      });
    } catch (error) {
      process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

const collectRepeatable = (value: string, previous: string[]): string[] => [...previous, value];

cli
  .command("add <name>")
  .description("Insert a new MCP entry into the resolved config file.")
  .option(
    "-t, --transport <transport>",
    "Transport: stdio | streamable-http | sse (default: stdio).",
    "stdio",
  )
  .option("-c, --config <path>", "Path to config file (otherwise auto-discovered).")
  .option("--description <text>", "Per-entry description; presence makes the entry lazy.")
  .option("--command <cmd>", "(stdio) Command to spawn for the upstream MCP.")
  .option(
    "--arg <arg>",
    "(stdio) Repeatable positional argument passed after --command.",
    collectRepeatable,
    [] as string[],
  )
  .option(
    "--env <KEY=VAL>",
    "(stdio) Repeatable env var for the spawned process.",
    collectRepeatable,
    [] as string[],
  )
  .option("--url <url>", "(http/sse) Endpoint URL.")
  .option(
    "--header <header>",
    '(http/sse) Repeatable "Name: Value" header.',
    collectRepeatable,
    [] as string[],
  )
  .option("--client-id <id>", "(http/sse) Pre-registered OAuth client_id (skips DCR).")
  .option("--client-secret <secret>", "(http/sse) Pre-registered OAuth client_secret.")
  .option("--scope <scope>", "(http/sse) OAuth scope to request.")
  .option("--force", "Overwrite an existing entry with the same name.")
  .action(
    (
      name: string,
      options: {
        transport: string;
        config?: string;
        description?: string;
        command?: string;
        arg: string[];
        env: string[];
        url?: string;
        header: string[];
        clientId?: string;
        clientSecret?: string;
        scope?: string;
        force?: boolean;
      },
    ) => {
      try {
        const transport = options.transport as TransportKind;
        if (transport !== "stdio" && transport !== "streamable-http" && transport !== "sse") {
          throw new Error(
            `Invalid --transport '${options.transport}'. Must be one of: stdio, streamable-http, sse.`,
          );
        }
        add({
          name,
          transport,
          ...(options.config !== undefined ? { configPath: options.config } : {}),
          ...(options.force === true ? { force: true } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.command !== undefined ? { command: options.command } : {}),
          ...(options.arg.length > 0 ? { args: options.arg } : {}),
          ...(options.env.length > 0 ? { envVars: options.env } : {}),
          ...(options.url !== undefined ? { url: options.url } : {}),
          ...(options.header.length > 0 ? { headers: options.header } : {}),
          ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
          ...(options.clientSecret !== undefined ? { clientSecret: options.clientSecret } : {}),
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
        });
      } catch (error) {
        process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    },
  );

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
