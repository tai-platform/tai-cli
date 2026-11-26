import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { type FlagSpec, parseArgs } from "./args.js";
import {
  type Asset,
  type Catalog,
  findAsset,
  assertName,
  loadCatalog,
  parseKind,
  pickVersion,
  search,
} from "./catalog.js";
import { configPath, readConfig, resolveMarketplace, validateHome, writeConfig, normalizeHome } from "./config.js";
import { KINDS, MARKETPLACE_HOME, type Kind } from "./constants.js";
import { TaiError, UsageError } from "./errors.js";
import {
  assertScope,
  fileHealth,
  installAsset,
  mcpServersMissing,
  persist,
  targets,
  uninstallAsset,
  type Outcome,
} from "./install.js";
import { type Lock, type LockEntry, type Scope, findEntry, lockPath, readLock } from "./lock.js";
import { type Resolved, parseSpec, resolveTree } from "./resolve.js";
import * as semver from "./semver.js";
import { readText } from "./source.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdio: IO = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
};

const G: FlagSpec = { long: "global", short: "g" };
const JSON_: FlagSpec = { long: "json" };
const DRY: FlagSpec = { long: "dry-run" };

interface Command {
  usage: string;
  summary: string;
  flags: FlagSpec[];
  run: (c: Ctx) => Promise<number>;
}

interface Ctx {
  io: IO;
  pos: string[];
  flags: Record<string, string | boolean>;
}

export function version(): string {
  const pkg = fileURLToPath(new URL("../../package.json", import.meta.url));
  return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
}

const scopeOf = (c: Ctx): Scope => (c.flags.global ? "global" : "local");

const where = (s: Scope) => (s === "global" ? "globally" : "in this repo");

function nothingInstalled(s: Scope): string {
  return `Nothing installed ${where(s)}: no ${lockPath(s)}${s === "local" ? ". Use -g for global installs." : "."}`;
}

async function readInstalled(s: Scope): Promise<Lock | null> {
  const lock = await readLock(s);
  return lock.assets.length ? lock : null;
}

async function market(c: Ctx, locks: Lock[]): Promise<{ home: string; cat: Catalog }> {
  const { home, origin } = resolveMarketplace(c.flags.marketplace as string | undefined);
  let use = home;
  if (origin === "default") {
    const pinned = locks.find((l) => l.marketplace)?.marketplace;
    if (pinned) use = normalizeHome(pinned);
  }
  return { home: use, cat: await loadCatalog(use) };
}

function withMarketplace(c: Ctx, lock: Lock, home: string): void {
  const { origin } = resolveMarketplace(c.flags.marketplace as string | undefined);
  if (origin !== "default") lock.marketplace = home;
}

async function safeLock(scope: Scope): Promise<Lock> {
  try {
    return await readLock(scope);
  } catch {
    return { assets: [] };
  }
}

function splitSpec(pos: string[], command: string): { kind: Kind; name: string; range?: string } {
  if (pos.length !== 2) throw new UsageError(`${command} needs <kind> <name>, for example: tai ${command} prompt my-prompt`);
  const kind = parseKind(pos[0]);
  const { name, range } = parseSpec(pos[1]);
  assertName(name);
  return { kind, name, range };
}

const label = (e: { kind: string; name: string }) => `${e.kind}/${e.name}`;

function report(io: IO, verb: string, r: { kind: string; name: string }, ver: string, o: Outcome): void {
  const changed = o.written.length + o.removed.length;
  io.out(`${changed ? verb : "up to date"} ${label(r)}@${ver}`);
  for (const f of o.written) io.out(`  + ${f}`);
  for (const f of o.removed) io.out(`  - ${f}`);
  for (const f of o.backedUp) io.out(`  ! kept your edited copy as ${f}`);
}

function fileList(r: Resolved, scope: Scope): string[] {
  return r.kind === "mcp"
    ? ["mcp-config.json (merged)"]
    : targets(r.kind, r.name, r.version.files, scope).map((t) => t.rel);
}

async function installTree(c: Ctx, tree: Resolved[], home: string, scope: Scope, lock: Lock): Promise<number> {
  const order = [...tree].reverse();
  if (c.flags["dry-run"]) {
    for (const r of order) {
      c.io.out(`would install ${label(r)}@${r.version.version}`);
      for (const f of fileList(r, scope)) c.io.out(`  + ${f}`);
    }
    return 0;
  }
  for (const r of order) assertScope(r.kind, scope);
  for (const r of order) {
    const o = await installAsset(home, r, scope, lock);
    withMarketplace(c, lock, home);
    await persist(lock, scope);
    report(c.io, "installed", r, r.version.version, o);
  }
  return 0;
}

async function restore(c: Ctx, scope: Scope): Promise<number> {
  const lock = await readInstalled(scope);
  if (!lock) throw new TaiError(nothingInstalled(scope).replace("Nothing installed", "Nothing to install"));
  const { home, cat } = await market(c, [lock]);
  let failed = 0;
  for (const e of [...lock.assets]) {
    try {
      const version = pickVersion(findAsset(cat, e.kind, e.name), e.version);
      if (c.flags["dry-run"]) {
        c.io.out(`would restore ${label(e)}@${e.version}`);
        continue;
      }
      report(c.io, "restored", e, e.version, await installAsset(home, { kind: e.kind, name: e.name, version }, scope, lock));
      await persist(lock, scope);
    } catch (err) {
      failed++;
      c.io.err(`tai: ${label(e)}@${e.version}: ${(err as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

const commands: Record<string, Command> = {
  search: {
    usage: "search [query] [-k <kind>] [--json]",
    summary: "Find assets in the marketplace",
    flags: [{ long: "kind", short: "k", value: true }, JSON_],
    async run(c) {
      if (c.pos.length > 1) throw new UsageError("search takes at most one query");
      const { cat } = await market(c, [await safeLock("local"), await safeLock("global")]);
      const kind = c.flags.kind ? parseKind(c.flags.kind as string) : undefined;
      const hits = search(cat, c.pos[0] ?? "", kind);
      const locks = { local: await safeLock("local"), global: await safeLock("global") };
      const rows = hits.map((a) => {
        const v = pickVersion(a).version;
        return {
          kind: a.kind,
          name: a.name,
          version: v,
          description: a.description,
          author: a.author,
          tags: a.tags ?? [],
          installed: {
            local: findEntry(locks.local, a.kind, a.name)?.version ?? null,
            global: findEntry(locks.global, a.kind, a.name)?.version ?? null,
          },
        };
      });
      if (c.flags.json) {
        c.io.out(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) {
        c.io.out("No matches.");
        return 0;
      }
      for (const r of rows) {
        const mark = [r.installed.local && "repo", r.installed.global && "global"].filter(Boolean).join(",");
        c.io.out(`${label(r).padEnd(44)} ${r.version.padEnd(8)} ${r.description}${mark ? `  [installed: ${mark}]` : ""}`);
      }
      return 0;
    },
  },

  view: {
    usage: "view <kind> <name>[@range] [--raw] [--json]",
    summary: "Show an asset's details and definition (--raw prints only the definition)",
    flags: [{ long: "raw" }, JSON_],
    async run(c) {
      const { kind, name, range } = splitSpec(c.pos, "view");
      const { home, cat } = await market(c, [await safeLock("local"), await safeLock("global")]);
      const asset: Asset = findAsset(cat, kind, name);
      const v = pickVersion(asset, range);
      if (c.flags.json) {
        c.io.out(JSON.stringify({ ...asset, selected: v.version }, null, 2));
        return 0;
      }
      const definition = await readText(home, `${v.path}/${v.files.find((f) => f === "SKILL.md") ?? v.files[0]}`);
      if (c.flags.raw) {
        c.io.out(definition.replace(/\n$/, ""));
        return 0;
      }
      c.io.out(`${label(asset)}@${v.version}`);
      c.io.out(asset.description);
      if (asset.author) c.io.out(`author:   ${asset.author}`);
      const others = (asset.contributors ?? []).filter((p) => p.login.toLowerCase() !== asset.author?.toLowerCase());
      if (others.length) c.io.out(`others:   ${others.map((p) => p.login).join(", ")}`);
      if (asset.maturity) c.io.out(`maturity: ${asset.maturity}`);
      if (asset.phase) c.io.out(`phase:    ${asset.phase}`);
      if (asset.tags?.length) c.io.out(`tags:     ${asset.tags.join(", ")}`);
      c.io.out(`versions: ${asset.versions.map((x) => x.version).join(", ")}`);
      for (const d of v.dependencies ?? []) c.io.out(`needs:    ${d.kind}/${d.name}${d.version ? "@" + d.version : ""}`);
      for (const s of ["local", "global"] as const) {
        const e = findEntry(await safeLock(s), kind, name);
        if (e) c.io.out(`installed (${s === "local" ? "repo" : "global"}): ${e.version}`);
      }
      c.io.out(`files:    ${v.files.join(", ")}`);
      c.io.out(`\n${definition.replace(/\n$/, "")}`);
      return 0;
    },
  },

  install: {
    usage: "install [<kind> <name>[@range]] [-g] [--dry-run]",
    summary: "Install an asset and its dependencies; with no asset, restore everything in .tai.yaml",
    flags: [G, DRY],
    async run(c) {
      const scope = scopeOf(c);
      if (!c.pos.length) return restore(c, scope);
      const { kind, name, range } = splitSpec(c.pos, "install");
      assertScope(kind, scope);
      const lock = await readLock(scope);
      const { home, cat } = await market(c, [lock]);
      const tree = [...resolveTree(cat, kind, name, range).values()];
      return installTree(c, tree, home, scope, lock);
    },
  },

  uninstall: {
    usage: "uninstall <kind> <name> [-g] [--dry-run]",
    summary: "Remove an installed asset and tidy empty folders",
    flags: [G, DRY],
    async run(c) {
      const { kind, name } = splitSpec(c.pos, "uninstall");
      const scope = scopeOf(c);
      const lock = await readLock(scope);
      const entry = findEntry(lock, kind, name);
      if (!entry) {
        const other: Scope = scope === "local" ? "global" : "local";
        const there = findEntry(await safeLock(other), kind, name);
        const hint = there ? ` It is installed ${other === "global" ? "globally; add -g" : "in this repo; drop -g"}.` : "";
        throw new TaiError(`${kind}/${name} is not installed ${where(scope)}.${hint}`);
      }
      if (c.flags["dry-run"]) {
        c.io.out(`would remove ${label(entry)}@${entry.version}`);
        for (const f of entry.files ?? []) c.io.out(`  - ${f.path}`);
        for (const s of entry.servers ?? []) c.io.out(`  - mcp server ${s}`);
        return 0;
      }
      const o = await uninstallAsset(entry, scope, lock);
      await persist(lock, scope);
      report(c.io, "removed", entry, entry.version, o);
      return 0;
    },
  },

  list: {
    usage: "list [-g] [--json]",
    summary: "List assets recorded in .tai.yaml (this repo, or -g for global)",
    flags: [G, JSON_],
    async run(c) {
      const scope = scopeOf(c);
      const lock = await readInstalled(scope);
      if (c.flags.json) {
        const rows = (lock?.assets ?? []).map((e) => ({ scope, kind: e.kind, name: e.name, version: e.version }));
        c.io.out(JSON.stringify(rows, null, 2));
      } else if (!lock) {
        c.io.out(nothingInstalled(scope));
      } else {
        for (const e of lock.assets) c.io.out(`${label(e).padEnd(44)} ${e.version}`);
      }
      return 0;
    },
  },

  update: {
    usage: "update [<kind> <name>] [-g] [--dry-run]",
    summary: "Move installed assets to the latest published version",
    flags: [G, DRY],
    async run(c) {
      const scope = scopeOf(c);
      const lock = await readInstalled(scope);
      if (!lock) {
        c.io.out(nothingInstalled(scope));
        return 0;
      }
      let targetsE: LockEntry[] = lock.assets;
      if (c.pos.length) {
        const { kind, name } = splitSpec(c.pos, "update");
        const e = findEntry(lock, kind, name);
        if (!e) throw new TaiError(`${kind}/${name} is not installed ${where(scope)}`);
        targetsE = [e];
      }
      const { home, cat } = await market(c, [lock]);
      let n = 0;
      for (const e of targetsE) {
        const latest = pickVersion(findAsset(cat, e.kind, e.name));
        if (semver.compare(latest.version, e.version) <= 0) continue;
        n++;
        c.io.out(`${label(e)} ${e.version} -> ${latest.version}`);
        const tree = [...resolveTree(cat, e.kind, e.name).values()];
        await installTree(c, tree, home, scope, lock);
      }
      if (!n) c.io.out("Everything is up to date.");
      return 0;
    },
  },

  outdated: {
    usage: "outdated [-g] [--json]",
    summary: "Show assets with a newer published version (exit 1 if any)",
    flags: [G, JSON_],
    async run(c) {
      const scope = scopeOf(c);
      const lock = await readInstalled(scope);
      if (!lock) {
        c.io.out(c.flags.json ? "[]" : nothingInstalled(scope));
        return 0;
      }
      const { cat } = await market(c, [lock]);
      const rows: { asset: string; current: string; latest: string }[] = [];
      for (const e of lock.assets) {
        const a = cat.assets.find((x) => x.kind === e.kind && x.name === e.name);
        const latest = a ? pickVersion(a).version : "removed";
        if (!a || semver.compare(latest, e.version) > 0) rows.push({ asset: label(e), current: e.version, latest });
      }
      if (c.flags.json) c.io.out(JSON.stringify(rows, null, 2));
      else if (!rows.length) c.io.out("Everything is up to date.");
      else for (const r of rows) c.io.out(`${r.asset.padEnd(44)} ${r.current} -> ${r.latest}`);
      return rows.length ? 1 : 0;
    },
  },

  doctor: {
    usage: "doctor [-g]",
    summary: "Check installed files against .tai.yaml and the marketplace (exit 1 on problems)",
    flags: [G],
    async run(c) {
      const scope = scopeOf(c);
      const lock = await readInstalled(scope);
      if (!lock) {
        c.io.out(nothingInstalled(scope));
        return 0;
      }
      let cat: Catalog | null = null;
      try {
        cat = (await market(c, [lock])).cat;
      } catch (e) {
        c.io.out(`warn  marketplace unreachable: ${(e as Error).message}`);
      }
      let problems = 0;
      for (const e of lock.assets) {
        const issues: string[] = [];
        for (const f of e.files ?? []) {
          const h = await fileHealth(scope, f);
          if (h !== "ok") issues.push(`${h}: ${f.path}`);
        }
        if (e.kind === "mcp") {
          for (const m of await mcpServersMissing(e, scope)) issues.push(`missing mcp server: ${m}`);
        } else if (!e.files?.length) {
          issues.push("no file record; run `tai install` to rebuild it");
        }
        const a = cat?.assets.find((x) => x.kind === e.kind && x.name === e.name);
        if (cat && !a?.versions.some((v) => v.version === e.version)) issues.push(`${e.version} is no longer published`);
        if (issues.length) {
          problems++;
          c.io.out(`FAIL  ${label(e)}@${e.version}`);
          for (const x of issues) c.io.out(`      ${x}`);
        } else c.io.out(`ok    ${label(e)}@${e.version}`);
      }
      if (problems) c.io.out(`${problems} of ${lock.assets.length} need attention`);
      return problems ? 1 : 0;
    },
  },

  config: {
    usage: "config [get|set|unset|path] [marketplace] [value]",
    summary: "Show or change the default marketplace",
    flags: [],
    async run(c) {
      const [action, key, value] = c.pos;
      if (!action) {
        const r = resolveMarketplace(c.flags.marketplace as string | undefined);
        c.io.out(`marketplace: ${r.home}`);
        c.io.out(`source:      ${r.origin}`);
        c.io.out(`default:     ${MARKETPLACE_HOME}`);
        return 0;
      }
      if (action === "path") {
        c.io.out(configPath());
        return 0;
      }
      if (!["get", "set", "unset"].includes(action)) throw new UsageError(`Unknown config action "${action}"`);
      if (key !== "marketplace") throw new UsageError("The only config key is: marketplace");
      if (action === "get") {
        c.io.out(readConfig().marketplace ?? "(not set)");
      } else if (action === "set") {
        if (!value) throw new UsageError("config set marketplace <url-or-directory>");
        validateHome(value);
        writeConfig({ ...readConfig(), marketplace: /^https?:/i.test(value) ? value.replace(/\/+$/, "") : normalizeHome(value) });
        c.io.out(`marketplace set to ${readConfig().marketplace}`);
      } else {
        writeConfig({ ...readConfig(), marketplace: undefined });
        c.io.out("marketplace reset to the built-in default");
      }
      return 0;
    },
  },
};

export function helpText(): string {
  const w = Math.max(...Object.values(commands).map((x) => x.usage.length));
  const lines = [
    `tai ${version()}  package manager for Copilot assets`,
    "",
    "Usage: tai <command> [options]",
    "",
    "Commands:",
    ...Object.values(commands).map((x) => `  ${x.usage.padEnd(w)}  ${x.summary}`),
    "",
    "Kinds: " + KINDS.join(", "),
    "",
    "Options:",
    "  --marketplace <url|dir>  use this marketplace for one run",
    "  -h, --help               show help (also: tai <command> --help)",
    "  --version                print version",
    "",
    "Environment: TAI_MARKETPLACE_HOME, TAI_TOKEN, TAI_HOME, COPILOT_HOME",
    `Default marketplace: ${MARKETPLACE_HOME}`,
  ];
  return lines.join("\n");
}

export async function run(argv: string[], io: IO = stdio): Promise<number> {
  const [name, ...rest] = argv;
  try {
    if (!name || name === "help" || name === "--help" || name === "-h") {
      io.out(helpText());
      return 0;
    }
    if (name === "--version" || name === "-v") {
      io.out(version());
      return 0;
    }
    const cmd = commands[name];
    if (!cmd) throw new UsageError(`Unknown command "${name}". Run \`tai --help\`.`);
    const { flags, pos } = parseArgs(rest, cmd.flags);
    if (flags.help) {
      io.out(`Usage: tai ${cmd.usage}\n\n${cmd.summary}`);
      return 0;
    }
    if (["list", "outdated", "doctor"].includes(name) && pos.length) {
      throw new UsageError(`${name} takes no arguments`);
    }
    return await cmd.run({ io, pos, flags });
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`tai: ${e.message}`);
      return 2;
    }
    if (e instanceof TaiError) {
      io.err(`tai: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
