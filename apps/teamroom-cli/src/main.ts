#!/usr/bin/env node
import { runCli } from "./cli.js";
import { renderError } from "./render.js";

try { process.stdout.write(await runCli(process.argv.slice(2))) }
catch (error) {
  process.stderr.write(renderError(error, process.argv.includes("--json")));
  process.exitCode = 1;
}
