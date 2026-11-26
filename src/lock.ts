import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENV_COPILOT_HOME, KINDS, LOCK_FILE, type Kind } from "./constants.js";
import { TaiError } from "./errors.js";

export interface LockFile {
  path: string;
  sha256: string;
}

export interface LockEntry {
  kind: Kind;
  name: string;
  version: string;
  servers?: string[];
  files?: LockFile[];
}

export interface Lock {
  marketplace?: string;
  assets: LockEntry[];
}

export type Scope = "local" | "global";

export function copilotHome(): string {
  return process.env[ENV_COPILOT_HOME] || path.join(os.homedir(), ".copilot");
}

export function baseDir(scope: Scope, cwd = process.cwd()): string {
  return scope === "global" ? copilotHome() : cwd;
}

export function lockPath(scope: Scope, cwd = process.cwd()): string {
  return path.join(baseDir(scope, cwd), LOCK_FILE);
}

const HEADER = "# Managed by tai. Commit this file so teammates can run `tai install`.\n";

const q = (s: string) => JSON.stringify(s);

export function serializeLock(lock: Lock): string {
  const lines = [HEADER.trimEnd()];
  if (lock.marketplace) lines.push(`marketplace: ${q(lock.marketplace)}`);
  if (!lock.assets.length) {
    lines.push("assets: []");
    return lines.join("\n") + "\n";
  }
  lines.push("assets:");
  const sorted = [...lock.assets].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
  for (const a of sorted) {
    lines.push(`  - kind: ${a.kind}`, `    name: ${a.name}`, `    version: ${a.version}`);
    if (a.servers?.length) lines.push(`    servers: [${a.servers.map(q).join(", ")}]`);
    if (a.files?.length) {
      lines.push("    files:");
      for (const f of a.files) lines.push(`      - ${q(`${f.sha256} ${f.path}`)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function scalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) return JSON.parse(s) as string;
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

export function parseLock(text: string, where = LOCK_FILE): Lock {
  const lock: Lock = { assets: [] };
  let cur: Record<string, unknown> | null = null;
  let listKey: string | null = null;

  const flush = () => {
    if (!cur) return;
    const { kind, name, version, servers, files } = cur as Record<string, any>;
    if (!kind || !name || !version) throw new TaiError(`${where}: asset entry needs kind, name and version`);
    if (!(KINDS as readonly string[]).includes(kind)) throw new TaiError(`${where}: unknown kind "${kind}"`);
    const entry: LockEntry = { kind, name, version };
    if (servers?.length) entry.servers = servers;
    if (files?.length) {
      entry.files = (files as string[]).map((s) => {
        const i = s.indexOf(" ");
        if (i < 1) throw new TaiError(`${where}: bad file entry "${s}"`);
        return { sha256: s.slice(0, i), path: s.slice(i + 1) };
      });
    }
    lock.assets.push(entry);
    cur = null;
  };

  const fail = (n: number, line: string): never => {
    throw new TaiError(`${where}: cannot parse line ${n}: ${line.trim()}`);
  };

  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    try {
      let m: RegExpExecArray | null;
      if ((m = /^marketplace:\s*(.+)$/.exec(line))) {
        lock.marketplace = scalar(m[1]);
      } else if (/^assets:\s*(\[\])?\s*$/.test(line)) {
        listKey = null;
      } else if ((m = /^ {2}- (\w+):\s*(.*)$/.exec(line))) {
        flush();
        cur = { [m[1]]: scalar(m[2]) };
        listKey = null;
      } else if ((m = /^ {4}(\w+):\s*(.*)$/.exec(line)) && cur) {
        const [, key, val] = m;
        if (val === "") {
          cur[key] = [];
          listKey = key;
        } else if (val.startsWith("[")) {
          cur[key] = JSON.parse(val);
          listKey = null;
        } else {
          cur[key] = scalar(val);
          listKey = null;
        }
      } else if ((m = /^ {6}- (.+)$/.exec(line)) && cur && listKey) {
        (cur[listKey] as string[]).push(scalar(m[1]));
      } else {
        fail(n, line);
      }
    } catch (e) {
      if (e instanceof TaiError) throw e;
      fail(n, line);
    }
  });
  flush();
  return lock;
}

export async function readLock(scope: Scope, cwd?: string): Promise<Lock> {
  const file = lockPath(scope, cwd);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { assets: [] };
    throw new TaiError(`Cannot read ${file}: ${(e as Error).message}`);
  }
  return parseLock(text, file);
}

export async function writeLock(lock: Lock, scope: Scope, cwd?: string): Promise<void> {
  const file = lockPath(scope, cwd);
  if (!lock.assets.length) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tai-tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, serializeLock(lock));
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export function findEntry(lock: Lock, kind: Kind, name: string): LockEntry | undefined {
  return lock.assets.find((a) => a.kind === kind && a.name === name);
}

export function setEntry(lock: Lock, entry: LockEntry): void {
  lock.assets = lock.assets.filter((a) => !(a.kind === entry.kind && a.name === entry.name));
  lock.assets.push(entry);
}

export function removeEntry(lock: Lock, kind: Kind, name: string): void {
  lock.assets = lock.assets.filter((a) => !(a.kind === kind && a.name === name));
}
