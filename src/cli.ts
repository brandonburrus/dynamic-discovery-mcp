import process from "node:process";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import figlet from "figlet";
import chalk from "chalk";
import { startProxy } from "./proxy/index.js";

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
  .addHelpText("after", "\nExample:\n  dynmcp -- npx -y chrome-devtools-mcp@latest\n")
  .allowExcessArguments(true)
  .passThroughOptions(true)
  .action(async () => {
    const separatorIndex = process.argv.indexOf("--");

    if (separatorIndex === -1) {
      process.stderr.write(
        "dynmcp: no upstream command provided.\n" +
          "Usage: dynmcp -- <command> [args...]\n" +
          "Example: dynmcp -- npx -y chrome-devtools-mcp@latest\n",
      );
      process.exit(1);
    }

    const [command, ...args] = process.argv.slice(separatorIndex + 1);

    if (command === undefined) {
      process.stderr.write(
        "dynmcp: no upstream command provided.\n" +
          "Usage: dynmcp -- <command> [args...]\n" +
          "Example: dynmcp -- npx -y chrome-devtools-mcp@latest\n",
      );
      process.exit(1);
    }

    try {
      await startProxy(command, args);
    } catch (error) {
      process.stderr.write(`dynmcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });
