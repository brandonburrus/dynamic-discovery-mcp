import process from "node:process";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import figlet from "figlet";
import chalk from "chalk";
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
      "  dynmcp --config ./mcp.json\n",
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
