#!/usr/bin/env node
import { run } from "../src/cli.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`tai: unexpected error: ${(e as Error).stack}`);
    process.exitCode = 1;
  },
);
