import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Kind } from "./constants.js";
import { TaiError } from "./errors.js";
import {
  type Lock,
  type LockEntry,
  type LockFile,
  type Scope,
  baseDir,
  findEntry,
  removeEntry,
  setEntry,
  writeLock,
} from "./lock.js";
import type { Resolved } from "./resolve.js";
import { readBytes } from "./source.js";

export const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".py", ".pl", ".rb"]);

const SECTION: Partial<Record<Kind, string>> = {
  prompt: "prompts",
  instruction: "instructions",
  agent: "agents",
  skill: "skills",
};

export const MCP_FILE = "mcp-config.json";

export function prefix(scope: Scope): string {
  return scope === "local" ? ".github" : "";
}

const join = (...p: string[]) => p.filter(Boolean).join("/");

export function assertScope(kind: Kind, scope: Scope): void {
  if (kind === "mcp" && scope === "local") {
    throw new TaiError("mcp servers live in ~/.copilot/mcp-config.json; use --global");
  }
}

function safeRel(rel: string): string {
  const parts = rel.split("/");
  if (!rel || rel.includes("\\") || rel.includes(":") || parts.some((s) => !s || s === "." || s === "..")) {
    throw new TaiError(`Unsafe file path in marketplace: ${rel}`);
  }
  return rel;
}

export function targets(kind: Kind, name: string, files: string[], scope: Scope): { src: string; rel: string }[] {
  const pre = prefix(scope);
  if (kind === "mcp") return [];
  if (kind === "skill") return files.map((f) => ({ src: f, rel: join(pre, "skills", name, safeRel(f)) }));
  const section = SECTION[kind]!;
  return [{ src: files[0], rel: join(pre, section, safeRel(files[0])) }];
}

const abs = (scope: Scope, rel: string, cwd?: string) => path.join(baseDir(scope, cwd), ...rel.split("/"));

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export interface Outcome {
  written: string[];
  unchanged: string[];
  backedUp: string[];
  removed: string[];
}

const empty = (): Outcome => ({ written: [], unchanged: [], backedUp: [], removed: [] });

async function readIf(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function wantsExec(file: string, buf: Buffer): boolean {
  if (process.platform === "win32") return false;
  return SCRIPT_EXT.has(path.extname(file).toLowerCase()) || buf.subarray(0, 2).toString() === "#!";
}

async function writeAtomic(file: string, buf: Buffer, exec: boolean): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tai-tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, buf, { mode: exec ? 0o755 : 0o644 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

async function prune(base: string, file: string): Promise<void> {
  let dir = path.dirname(file);
  while (dir.startsWith(base + path.sep) && dir !== base) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

interface Download {
  rel: string;
  buf: Buffer;
  sha: string;
}

async function download(home: string, r: Resolved, scope: Scope): Promise<Download[]> {
  const v = r.version;
  const out: Download[] = [];
  const map = r.kind === "mcp" ? v.files.map((f) => ({ src: f, rel: "" })) : targets(r.kind, r.name, v.files, scope);
  for (const t of map) {
    const buf = await readBytes(home, `${v.path}/${t.src}`);
    const sha = sha256(buf);
    const expected = v.integrity?.[t.src];
    if (expected && expected !== `sha256-${sha}`) {
      throw new TaiError(`Integrity check failed for ${r.kind}/${r.name}: ${t.src}`);
    }
    out.push({ rel: t.rel, buf, sha });
  }
  return out;
}

interface McpDoc {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

async function readMcpTarget(file: string): Promise<McpDoc> {
  const buf = await readIf(file);
  if (!buf) return {};
  try {
    return JSON.parse(buf.toString("utf8")) as McpDoc;
  } catch {
    throw new TaiError(`${file} is not valid JSON; fix it before installing mcp servers`);
  }
}

async function installMcp(r: Resolved, dl: Download[], scope: Scope, cwd: string | undefined, out: Outcome) {
  let incoming: McpDoc;
  try {
    incoming = JSON.parse(dl[0].buf.toString("utf8")) as McpDoc;
  } catch {
    throw new TaiError(`mcp/${r.name} is not valid JSON`);
  }
  const servers = incoming.mcpServers ?? {};
  const names = Object.keys(servers);
  if (!names.length) throw new TaiError(`mcp/${r.name} declares no mcpServers`);
  const file = abs(scope, MCP_FILE, cwd);
  const doc = await readMcpTarget(file);
  doc.mcpServers = { ...(doc.mcpServers ?? {}), ...servers };
  const next = Buffer.from(JSON.stringify(doc, null, 2) + "\n");
  const prev = await readIf(file);
  if (prev && sha256(prev) === sha256(next)) out.unchanged.push(MCP_FILE);
  else {
    await writeAtomic(file, next, false);
    out.written.push(MCP_FILE);
  }
  return names;
}

export async function installAsset(
  home: string,
  r: Resolved,
  scope: Scope,
  lock: Lock,
  cwd?: string,
): Promise<Outcome> {
  assertScope(r.kind, scope);
  const dl = await download(home, r, scope);
  const out = empty();
  const prev = findEntry(lock, r.kind, r.name);
  const base = baseDir(scope, cwd);

  if (r.kind === "mcp") {
    const servers = await installMcp(r, dl, scope, cwd, out);
    setEntry(lock, { kind: r.kind, name: r.name, version: r.version.version, servers });
    return out;
  }

  const recorded = new Map((prev?.files ?? []).map((f) => [f.path, f.sha256]));
  const files: LockFile[] = [];
  for (const d of dl) {
    const file = abs(scope, d.rel, cwd);
    files.push({ path: d.rel, sha256: d.sha });
    const cur = await readIf(file);
    if (cur) {
      const curSha = sha256(cur);
      if (curSha === d.sha) {
        out.unchanged.push(d.rel);
        continue;
      }
      if (recorded.get(d.rel) !== curSha) {
        const bak = `${file}.bak-${stamp()}`;
        await fs.rename(file, bak);
        out.backedUp.push(path.relative(base, bak).split(path.sep).join("/"));
      }
    }
    await writeAtomic(file, d.buf, wantsExec(file, d.buf));
    out.written.push(d.rel);
  }

  const keep = new Set(files.map((f) => f.path));
  for (const old of prev?.files ?? []) {
    if (keep.has(old.path)) continue;
    await removeFile(base, scope, old, cwd, out);
  }

  setEntry(lock, { kind: r.kind, name: r.name, version: r.version.version, files });
  return out;
}

async function removeFile(base: string, scope: Scope, f: LockFile, cwd: string | undefined, out: Outcome) {
  const file = abs(scope, f.path, cwd);
  const cur = await readIf(file);
  if (!cur) return;
  if (sha256(cur) === f.sha256) {
    await fs.rm(file);
    out.removed.push(f.path);
  } else {
    const bak = `${file}.bak-${stamp()}`;
    await fs.rename(file, bak);
    out.backedUp.push(path.relative(base, bak).split(path.sep).join("/"));
  }
  await prune(base, file);
}

export async function uninstallAsset(
  entry: LockEntry,
  scope: Scope,
  lock: Lock,
  cwd?: string,
): Promise<Outcome> {
  const out = empty();
  const base = baseDir(scope, cwd);

  if (entry.kind === "mcp") {
    const file = abs(scope, MCP_FILE, cwd);
    if (await readIf(file)) {
      const doc = await readMcpTarget(file);
      for (const s of entry.servers ?? []) delete doc.mcpServers?.[s];
      if (doc.mcpServers && !Object.keys(doc.mcpServers).length) delete doc.mcpServers;
      if (!Object.keys(doc).length) await fs.rm(file);
      else await writeAtomic(file, Buffer.from(JSON.stringify(doc, null, 2) + "\n"), false);
      out.removed.push(MCP_FILE);
    }
  } else {
    for (const f of entry.files ?? []) await removeFile(base, scope, f, cwd, out);
  }
  removeEntry(lock, entry.kind, entry.name);
  return out;
}

export async function persist(lock: Lock, scope: Scope, cwd?: string): Promise<void> {
  await writeLock(lock, scope, cwd);
}

export type Health = "ok" | "missing" | "modified";

export async function fileHealth(scope: Scope, f: LockFile, cwd?: string): Promise<Health> {
  const cur = await readIf(abs(scope, f.path, cwd));
  if (!cur) return "missing";
  return sha256(cur) === f.sha256 ? "ok" : "modified";
}

export async function mcpServersMissing(entry: LockEntry, scope: Scope, cwd?: string): Promise<string[]> {
  const file = abs(scope, MCP_FILE, cwd);
  if (!(await readIf(file))) return entry.servers ?? [];
  const doc = await readMcpTarget(file);
  return (entry.servers ?? []).filter((s) => !(doc.mcpServers && s in doc.mcpServers));
}
