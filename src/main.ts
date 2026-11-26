#!/usr/bin/env node
import { run } from "./cli.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`tai: unexpected error: ${(e as Error).stack}`);
    process.exitCode = 1;
  },
);
