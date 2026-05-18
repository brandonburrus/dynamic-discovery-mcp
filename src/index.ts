import { cli } from "./cli.js";
import process from "node:process";

async function main() {
  cli.parse(process.argv);
}

main();
