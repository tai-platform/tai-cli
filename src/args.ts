import { UsageError } from "./errors.js";

export interface FlagSpec {
  long: string;
  short?: string;
  value?: boolean;
}

export interface Parsed {
  flags: Record<string, string | boolean>;
  pos: string[];
}

export const MARKETPLACE_FLAG: FlagSpec = { long: "marketplace", value: true };
export const HELP_FLAG: FlagSpec = { long: "help", short: "h" };

export function parseArgs(argv: string[], specs: FlagSpec[]): Parsed {
  const all = [...specs, MARKETPLACE_FLAG, HELP_FLAG];
  const flags: Parsed["flags"] = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      pos.push(a);
      continue;
    }
    let name = a.replace(/^-{1,2}/, "");
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const spec = a.startsWith("--") ? all.find((s) => s.long === name) : all.find((s) => s.short === name);
    if (!spec) throw new UsageError(`Unknown option ${a.split("=")[0]}`);
    if (spec.value) {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("-"))) {
        throw new UsageError(`Option --${spec.long} needs a value`);
      }
      flags[spec.long] = v;
    } else {
      if (inline !== undefined) throw new UsageError(`Option --${spec.long} takes no value`);
      flags[spec.long] = true;
    }
  }
  return { flags, pos };
}
