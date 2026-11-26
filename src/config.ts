import fs from "node:fs";
import path from "node:path";
import { ENV_MARKETPLACE, MARKETPLACE_HOME, configDir } from "./constants.js";
import { TaiError } from "./errors.js";

export interface Config {
  marketplace?: string;
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function readConfig(): Config {
  let text: string;
  try {
    text = fs.readFileSync(configPath(), "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as Config;
  } catch {
    throw new TaiError(`${configPath()} is not valid JSON; fix or delete it`);
  }
}

export function writeConfig(cfg: Config): void {
  const file = configPath();
  if (!cfg.marketplace) {
    fs.rmSync(file, { force: true });
    try {
      fs.rmdirSync(path.dirname(file));
    } catch {
      return;
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

export function resolveMarketplace(flag?: string): { home: string; origin: string } {
  if (flag) return { home: normalizeHome(flag), origin: "--marketplace" };
  const env = process.env[ENV_MARKETPLACE];
  if (env) return { home: normalizeHome(env), origin: ENV_MARKETPLACE };
  const cfg = readConfig().marketplace;
  if (cfg) return { home: normalizeHome(cfg), origin: "config" };
  return { home: normalizeHome(MARKETPLACE_HOME), origin: "default" };
}

export function normalizeHome(value: string): string {
  const v = value.trim().replace(/[\\/]+$/, "");
  if (!v) throw new TaiError("Marketplace location is empty");
  if (/^https?:\/\//i.test(v)) return v;
  if (/^file:\/\//i.test(v)) return decodeURIComponent(new URL(v).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  return path.resolve(v);
}

export function validateHome(value: string): void {
  const home = normalizeHome(value);
  if (/^https?:\/\//i.test(home)) {
    try {
      new URL(home);
    } catch {
      throw new TaiError(`Not a valid URL: ${value}`);
    }
    return;
  }
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    throw new TaiError(`Not an existing directory: ${home}`);
  }
}
