import os from "node:os";
import path from "node:path";

export const MARKETPLACE_HOME = "https://tai-platform.github.io/tai-marketplace";

export const CATALOG_FILE = "catalog.json";
export const ENV_MARKETPLACE = "TAI_MARKETPLACE_HOME";
export const ENV_TOKEN = "TAI_TOKEN";
export const ENV_CONFIG_DIR = "TAI_HOME";
export const LOCK_FILE = ".tai.yaml";

export const KINDS = ["prompt", "skill", "instruction", "agent", "mcp"] as const;
export type Kind = (typeof KINDS)[number];
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const ENV_COPILOT_HOME = "COPILOT_HOME";

export function configDir(): string {
  return process.env[ENV_CONFIG_DIR] || path.join(os.homedir(), ".tai");
}
