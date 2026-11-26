import { TaiError } from "./errors.js";

export interface Ver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

interface Comparator {
  op: "<" | "<=" | ">" | ">=" | "=";
  v: Ver;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(v: string): Ver | null {
  const m = VERSION.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

export function valid(v: string): boolean {
  return parse(v) !== null;
}

function cmpId(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(+a - +b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVer(a: Ver, b: Ver): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = cmpId(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
}

export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new TaiError(`Invalid version "${pa ? b : a}"`);
  return compareVer(pa, pb);
}

const ver = (major: number, minor = 0, patch = 0, pre: string[] = []): Ver => ({ major, minor, patch, pre });
const wild = (s: string | undefined) => s === undefined || s === "x" || s === "X" || s === "*";

interface Partial_ {
  major?: number;
  minor?: number;
  patch?: number;
  pre: string[];
}

function parsePartial(s: string): Partial_ {
  const m = PARTIAL.exec(s);
  if (!m) throw new TaiError(`Invalid version range "${s}"`);
  const [, a, b, c, pre] = m;
  const p: Partial_ = { pre: pre ? pre.split(".") : [] };
  if (!wild(a)) {
    p.major = +a;
    if (!wild(b)) {
      p.minor = +b!;
      if (!wild(c)) p.patch = +c!;
    }
  }
  return p;
}

const ANY: Comparator[] = [{ op: ">=", v: ver(0) }];

function xrange(p: Partial_): Comparator[] {
  if (p.major === undefined) return ANY;
  if (p.minor === undefined) return [{ op: ">=", v: ver(p.major) }, { op: "<", v: ver(p.major + 1) }];
  if (p.patch === undefined) {
    return [{ op: ">=", v: ver(p.major, p.minor) }, { op: "<", v: ver(p.major, p.minor + 1) }];
  }
  return [{ op: "=", v: ver(p.major, p.minor, p.patch, p.pre) }];
}

function caret(p: Partial_): Comparator[] {
  if (p.major === undefined) return ANY;
  const { major: M } = p;
  if (p.minor === undefined) {
    return [{ op: ">=", v: ver(M) }, { op: "<", v: ver(M + 1) }];
  }
  const m = p.minor;
  if (p.patch === undefined) {
    const upper = M > 0 ? ver(M + 1) : m > 0 ? ver(0, m + 1) : ver(0, 1);
    return [{ op: ">=", v: ver(M, m) }, { op: "<", v: upper }];
  }
  const pt = p.patch;
  const upper = M > 0 ? ver(M + 1) : m > 0 ? ver(0, m + 1) : ver(0, 0, pt + 1);
  return [{ op: ">=", v: ver(M, m, pt, p.pre) }, { op: "<", v: upper }];
}

function tilde(p: Partial_): Comparator[] {
  if (p.major === undefined) return ANY;
  if (p.minor === undefined) return [{ op: ">=", v: ver(p.major) }, { op: "<", v: ver(p.major + 1) }];
  const lower = ver(p.major, p.minor, p.patch ?? 0, p.pre);
  return [{ op: ">=", v: lower }, { op: "<", v: ver(p.major, p.minor + 1) }];
}

function withOp(op: string, p: Partial_): Comparator[] {
  if (p.major === undefined) return op === "<" || op === ">" ? [{ op: "<", v: ver(0) }] : ANY;
  const full = p.minor !== undefined && p.patch !== undefined;
  const lo = ver(p.major, p.minor ?? 0, p.patch ?? 0, p.pre);
  switch (op) {
    case ">=":
      return [{ op: ">=", v: lo }];
    case "<":
      return [{ op: "<", v: lo }];
    case ">": {
      if (full) return [{ op: ">", v: lo }];
      const next = p.minor === undefined ? ver(p.major + 1) : ver(p.major, p.minor + 1);
      return [{ op: ">=", v: next }];
    }
    case "<=": {
      if (full) return [{ op: "<=", v: lo }];
      const next = p.minor === undefined ? ver(p.major + 1) : ver(p.major, p.minor + 1);
      return [{ op: "<", v: next }];
    }
    default:
      return xrange(p);
  }
}

function parseComparatorSet(set: string): Comparator[] {
  let s = set.trim();
  if (!s || s === "*" || s === "x" || s === "X") return ANY;

  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hy) {
    return [...withOp(">=", parsePartial(hy[1])), ...withOp("<=", parsePartial(hy[2]))];
  }

  s = s.replace(/(\^|~>?|[<>]=?|=)\s+/g, "$1");
  const out: Comparator[] = [];
  for (const tok of s.split(/\s+/)) {
    const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(tok)!;
    const op = m[1] === "~>" ? "~" : m[1];
    const p = parsePartial(m[2]);
    if (op === "^") out.push(...caret(p));
    else if (op === "~") out.push(...tilde(p));
    else if (op && op !== "=") out.push(...withOp(op, p));
    else out.push(...xrange(p));
  }
  return out;
}

export function parseRange(range: string): Comparator[][] {
  return range.split("||").map(parseComparatorSet);
}

function test(c: Comparator, v: Ver): boolean {
  const r = compareVer(v, c.v);
  switch (c.op) {
    case "<":
      return r < 0;
    case "<=":
      return r <= 0;
    case ">":
      return r > 0;
    case ">=":
      return r >= 0;
    default:
      return r === 0;
  }
}

function satisfiesSet(set: Comparator[], v: Ver): boolean {
  if (!set.every((c) => test(c, v))) return false;
  if (!v.pre.length) return true;
  return set.some(
    (c) => c.v.pre.length && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch,
  );
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return parseRange(range).some((set) => satisfiesSet(set, v));
}

export function maxSatisfying(versions: string[], range: string): string | null {
  const sets = parseRange(range);
  let best: { raw: string; v: Ver } | null = null;
  for (const raw of versions) {
    const v = parse(raw);
    if (!v || !sets.some((s) => satisfiesSet(s, v))) continue;
    if (!best || compareVer(v, best.v) > 0) best = { raw, v };
  }
  return best?.raw ?? null;
}
