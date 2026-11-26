import fs from "node:fs/promises";
import path from "node:path";
import { ENV_TOKEN } from "./constants.js";
import { TaiError } from "./errors.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function isRemote(home: string): boolean {
  return /^https?:\/\//i.test(home);
}

function clean(rel: string): string {
  const c = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!c || c.split("/").some((s) => s === ".." || s === "")) {
    throw new TaiError(`Unsafe path in marketplace: ${rel}`);
  }
  return c;
}

export async function readBytes(home: string, rel: string): Promise<Buffer> {
  const c = clean(rel);

  if (!isRemote(home)) {
    const file = path.join(home, ...c.split("/"));
    try {
      const buf = await fs.readFile(file);
      if (buf.length > MAX_FILE_BYTES) throw new TaiError(`${c} exceeds ${MAX_FILE_BYTES} bytes`);
      return buf;
    } catch (e) {
      if (e instanceof TaiError) throw e;
      throw new TaiError(`Cannot read ${file}`);
    }
  }

  const url = `${home}/${c.split("/").map(encodeURIComponent).join("/")}`;
  const headers: Record<string, string> = { "User-Agent": "tai-cli" };
  const token = process.env[ENV_TOKEN];
  if (token) {
    const { protocol, hostname } = new URL(url);
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (protocol !== "https:" && !local) {
      throw new TaiError(`Refusing to send ${ENV_TOKEN} over plain http to ${hostname}`);
    }
    headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new TaiError(`Cannot reach ${url}: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const hint = token ? "" : ` (private marketplace? set ${ENV_TOKEN})`;
    throw new TaiError(`HTTP ${res.status} for ${url}${hint}`);
  }
  if (!res.ok) throw new TaiError(`HTTP ${res.status} for ${url}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES) throw new TaiError(`${c} exceeds ${MAX_FILE_BYTES} bytes`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new TaiError(`${c} exceeds ${MAX_FILE_BYTES} bytes`);
  return buf;
}

export async function readText(home: string, rel: string): Promise<string> {
  return (await readBytes(home, rel)).toString("utf8");
}
