import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { run } from "../src/cli.js";
import { parseLock, serializeLock } from "../src/lock.js";
import * as semver from "../src/semver.js";

interface Box {
  root: string;
  repo: string;
  copilot: string;
  taiHome: string;
  market: string;
}

let box: Box;
let saved: { cwd: string; env: Record<string, string | undefined> };
const ENV = ["COPILOT_HOME", "TAI_HOME", "TAI_MARKETPLACE_HOME", "TAI_TOKEN"];

interface Pub {
  kind: string;
  name: string;
  version: string;
  dir: string;
  files: Record<string, Buffer | string>;
  deps?: { kind: string; name: string; version?: string }[];
}

let published: Pub[] = [];

function publish(p: Pub): void {
  published = published.filter((x) => !(x.kind === p.kind && x.name === p.name));
  published.push(p);
  const assets = published.map((a) => {
    const integrity: Record<string, string> = {};
    for (const [f, c] of Object.entries(a.files)) {
      const buf = Buffer.from(c);
      integrity[f] = "sha256-" + crypto.createHash("sha256").update(buf).digest("hex");
      const file = path.join(box.market, a.dir, ...f.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    return {
      kind: a.kind,
      name: a.name,
      description: `${a.name} description`,
      tags: ["t-" + a.name],
      versions: [
        { version: a.version, path: a.dir, files: Object.keys(a.files), integrity, dependencies: a.deps ?? [] },
      ],
    };
  });
  fs.writeFileSync(path.join(box.market, "catalog.json"), JSON.stringify({ schemaVersion: 1, assets }));
}

const SCRIPT_FILES = {
  "SKILL.md": "# skill v1\n",
  "scripts/run.sh": "#!/usr/bin/env bash\necho hi\n",
  "scripts/run.py": "print('hi')\n",
  "scripts/run.ps1": "Write-Output hi\r\n",
  "scripts/run.cmd": "@echo off\r\necho hi\r\n",
  "assets/blob.bin": Buffer.from([0, 255, 1, 254, 0, 128, 13, 10, 26]),
};

function seed(): void {
  published = [];
  publish({ kind: "prompt", name: "hello", version: "1.0.0", dir: "manifest/prompts", files: { "hello.prompt.md": "hello v1\n" } });
  publish({ kind: "instruction", name: "style", version: "1.0.0", dir: "manifest/instructions", files: { "style.instructions.md": "style\n" } });
  publish({ kind: "agent", name: "rev", version: "1.0.0", dir: "manifest/agents", files: { "rev.agent.md": "agent\n" } });
  publish({
    kind: "skill",
    name: "tool",
    version: "1.0.0",
    dir: "manifest/skills/tool",
    files: SCRIPT_FILES,
    deps: [{ kind: "prompt", name: "hello", version: "^1.0.0" }],
  });
  publish({
    kind: "mcp",
    name: "srv",
    version: "1.0.0",
    dir: "manifest/mcp",
    files: { "srv.json": JSON.stringify({ tai: { name: "srv" }, mcpServers: { srv: { type: "http", url: "https://x.test" } } }) },
  });
}

beforeEach(() => {
  saved = { cwd: process.cwd(), env: Object.fromEntries(ENV.map((k) => [k, process.env[k]])) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tai-test-"));
  box = {
    root,
    repo: path.join(root, "repo"),
    copilot: path.join(root, "copilot"),
    taiHome: path.join(root, "taihome"),
    market: path.join(root, "market"),
  };
  for (const d of [box.repo, box.copilot, box.market]) fs.mkdirSync(d);
  process.chdir(box.repo);
  process.env.COPILOT_HOME = box.copilot;
  process.env.TAI_HOME = box.taiHome;
  process.env.TAI_MARKETPLACE_HOME = box.market;
  delete process.env.TAI_TOKEN;
  seed();
});

afterEach(() => {
  assertNoTmp(box.root);
  process.chdir(saved.cwd);
  for (const k of ENV) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  fs.rmSync(box.root, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function assertNoTmp(dir: string): void {
  const left = walk(dir).filter((f) => f.includes(".tai-tmp-"));
  assert.deepEqual(left, [], "temporary files left behind");
}

async function tai(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await run(args, { out: (s) => (out += s + "\n"), err: (s) => (err += s + "\n") });
  return { code, out, err };
}

const inRepo = (...p: string[]) => path.join(box.repo, ...p);
const inCopilot = (...p: string[]) => path.join(box.copilot, ...p);
const rel = (dir: string) => walk(dir).map((f) => path.relative(dir, f).split(path.sep).join("/")).sort();

describe("semver", () => {
  const cases: [string, string, boolean][] = [
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.9.0", "1.x", true],
    ["2.0.0", "1.x", false],
    ["3.0.0", "*", true],
    ["1.5.0", ">=1.2.0 <2.0.0", true],
    ["2.0.0", ">=1.2.0 <2.0.0", false],
    ["1.0.0", "1.0.0 || 2.0.0", true],
    ["2.0.0", "1.0.0 || 2.0.0", true],
    ["3.0.0", "1.0.0 || 2.0.0", false],
    ["1.5.0", "1.2.0 - 1.6.0", true],
    ["1.7.0", "1.2.0 - 1.6.0", false],
    ["1.0.0-beta.1", "^1.0.0", false],
    ["1.0.0-beta.2", "^1.0.0-beta.1", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["1.2.4", ">1.2.3", true],
    ["1.2.3", "<=1.2.3", true],
    ["1.2.3", "^ 1.0.0", true],
  ];
  for (const [v, r, want] of cases) {
    it(`${v} ${want ? "satisfies" : "fails"} ${r}`, () => assert.equal(semver.satisfies(v, r), want));
  }
  it("compares prerelease and numeric ids", () => {
    assert.ok(semver.compare("1.0.0-alpha", "1.0.0") < 0);
    assert.ok(semver.compare("1.0.0-alpha.2", "1.0.0-alpha.10") < 0);
    assert.ok(semver.compare("1.10.0", "1.9.0") > 0);
  });
  it("maxSatisfying picks the highest match", () => {
    assert.equal(semver.maxSatisfying(["1.0.0", "1.4.0", "2.0.0", "1.9.9-rc.1"], "^1.0.0"), "1.4.0");
    assert.equal(semver.maxSatisfying(["2.0.0"], "^1.0.0"), null);
  });
  it("rejects garbage ranges", () => {
    assert.throws(() => semver.satisfies("1.0.0", "not a range"));
  });
});

describe("lock file", () => {
  it("round-trips including quoted and awkward values", () => {
    const lock = {
      marketplace: "C:\\market dir",
      assets: [
        { kind: "skill" as const, name: "b", version: "1.0.0", files: [{ sha256: "ab", path: "skills/b/with space.md" }] },
        { kind: "mcp" as const, name: "a", version: "2.0.0-rc.1", servers: ["one", "two: x"] },
      ],
    };
    const back = parseLock(serializeLock(lock));
    assert.equal(back.marketplace, lock.marketplace);
    assert.deepEqual(back.assets.map((a) => a.name), ["a", "b"]);
    assert.deepEqual(back.assets[0].servers, ["one", "two: x"]);
    assert.equal(back.assets[1].files![0].path, "skills/b/with space.md");
  });
  it("parses a hand-written minimal lock", () => {
    const l = parseLock("assets:\n  - kind: prompt\n    name: hello\n    version: 1.0.0\n");
    assert.deepEqual(l.assets, [{ kind: "prompt", name: "hello", version: "1.0.0" }]);
  });
  it("reports a corrupt lock instead of treating it as empty", async () => {
    fs.writeFileSync(inRepo(".tai.yaml"), "assets:\n  garbage here\n");
    const r = await tai("list");
    assert.equal(r.code, 1);
    assert.match(r.err, /\.tai\.yaml/);
  });
});

describe("usage and help", () => {
  it("prints help and version", async () => {
    for (const a of [[], ["--help"], ["-h"], ["help"]]) {
      const r = await tai(...a);
      assert.equal(r.code, 0);
      assert.match(r.out, /Commands:/);
    }
    assert.match((await tai("--version")).out, /^\d+\.\d+\.\d+/);
    assert.match((await tai("-v")).out, /^\d+\.\d+\.\d+/);
  });
  it("has per-command help", async () => {
    for (const c of ["search", "view", "install", "uninstall", "list", "update", "outdated", "doctor", "config"]) {
      const r = await tai(c, "--help");
      assert.equal(r.code, 0, c);
      assert.match(r.out, new RegExp(`Usage: tai ${c}`));
      assert.equal((await tai(c, "-h")).code, 0);
    }
  });
  it("rejects unknown commands, flags, missing values and bad combos with exit 2", async () => {
    for (const a of [
      ["bogus"],
      ["list", "--nope"],
      ["install", "prompt", "hello", "--json"],
      ["search", "-k"],
      ["list", "--local"],
      ["outdated", "--local"],
      ["doctor", "--local"],
      ["list", "extra"],
      ["install", "prompt"],
      ["install", "a", "b", "c"],
      ["config", "frob"],
      ["config", "set", "other", "x"],
      ["list", "--json=1"],
      ["sync"],
      ["explore", "prompt", "hello"],
      ["install", "prompt/hello"],
      ["view", "prompt/hello"],
      ["uninstall", "prompt/hello"],
      ["view", "prompt", "hello", "--full"],
    ]) {
      const r = await tai(...a);
      assert.equal(r.code, 2, a.join(" "));
      assert.match(r.err, /^tai: /);
    }
  });
  it("accepts --flag=value", async () => {
    assert.equal((await tai("search", "--kind=prompt")).code, 0);
  });
  it("rejects unknown kinds and unsafe names", async () => {
    assert.equal((await tai("install", "copilot-instructions", "global")).code, 1);
    assert.equal((await tai("install", "widget", "x")).code, 1);
    assert.equal((await tai("install", "prompt", "../evil")).code, 1);
    assert.equal((await tai("install", "prompt", "Nope")).code, 1);
    assert.equal((await tai("install", "prompt", "missing")).code, 1);
  });
});

describe("search and view", () => {
  it("lists, filters by query and kind, supports --json", async () => {
    const all = await tai("search");
    assert.match(all.out, /prompt\/hello/);
    assert.match(all.out, /skill\/tool/);
    assert.match((await tai("search", "tool")).out, /skill\/tool/);
    assert.doesNotMatch((await tai("search", "tool")).out, /prompt\/hello/);
    assert.doesNotMatch((await tai("search", "-k", "agent")).out, /prompt\/hello/);
    assert.match((await tai("search", "t-hello")).out, /prompt\/hello/);
    assert.match((await tai("search", "zzz")).out, /No matches/);
    assert.equal((await tai("search", "zzz")).code, 0);
    const j = JSON.parse((await tai("search", "--json")).out);
    assert.equal(j.length, 5);
    assert.deepEqual(j[0].installed, { local: null, global: null });
    assert.equal((await tai("search", "-k", "nope")).code, 1);
  });
  it("marks installed assets per scope", async () => {
    await tai("install", "prompt", "hello");
    await tai("install", "agent", "rev", "-g");
    const out = (await tai("search")).out;
    assert.match(out, /prompt\/hello.*\[installed: repo\]/);
    assert.match(out, /agent\/rev.*\[installed: global\]/);
  });
  it("views one asset with details, --raw and --json", async () => {
    const r = await tai("view", "skill", "tool");
    assert.match(r.out, /skill\/tool@1\.0\.0/);
    assert.match(r.out, /needs:\s+prompt\/hello@\^1\.0\.0/);
    assert.match(r.out, /scripts\/run\.sh/);
    const full = await tai("view", "prompt", "hello");
    assert.match(full.out, /hello v1/);
    assert.equal((await tai("view", "prompt", "hello", "--raw")).out.trim(), "hello v1");
    const j = JSON.parse((await tai("view", "prompt", "hello", "--json")).out);
    assert.equal(j.selected, "1.0.0");
    assert.equal((await tai("view", "prompt", "hello@^2.0.0")).code, 1);
    assert.equal((await tai("view", "prompt", "missing")).code, 1);
  });
  it("shows installed status in view", async () => {
    await tai("install", "prompt", "hello", "-g");
    assert.match((await tai("view", "prompt", "hello")).out, /installed \(global\): 1\.0\.0/);
  });
});

describe("install in a repository", () => {
  it("places each kind under .github and records .tai.yaml", async () => {
    for (const [k, n] of [["prompt", "hello"], ["instruction", "style"],     ["agent", "rev"]]) {
      const r = await tai("install", k, n);
      assert.equal(r.code, 0, r.err);
    }
    assert.deepEqual(rel(inRepo(".github")), [
      "agents/rev.agent.md",
      "instructions/style.instructions.md",
      "prompts/hello.prompt.md",
    ]);
    assert.ok(fs.existsSync(inRepo(".tai.yaml")));
    assert.equal(fs.readFileSync(inRepo(".github", "prompts", "hello.prompt.md"), "utf8"), "hello v1\n");
    assert.deepEqual(rel(box.copilot), [], "nothing global was touched");
  });
  it("refuses mcp without --global and leaves no trace", async () => {
    const r = await tai("install", "mcp", "srv");
    assert.equal(r.code, 1);
    assert.match(r.err, /--global/);
    assert.deepEqual(rel(box.repo), []);
  });
  it("pulls dependencies first and installs helper scripts and binaries byte for byte", async () => {
    const r = await tai("install", "skill", "tool");
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.indexOf("prompt/hello") < r.out.indexOf("skill/tool"));
    const dir = inRepo(".github", "skills", "tool");
    assert.deepEqual(rel(dir), ["SKILL.md", "assets/blob.bin", "scripts/run.cmd", "scripts/run.ps1", "scripts/run.py", "scripts/run.sh"]);
    assert.ok(fs.readFileSync(path.join(dir, "assets", "blob.bin")).equals(SCRIPT_FILES["assets/blob.bin"]));
    assert.equal(fs.readFileSync(path.join(dir, "scripts", "run.cmd"), "utf8"), "@echo off\r\necho hi\r\n");
    assert.ok(fs.existsSync(inRepo(".github", "prompts", "hello.prompt.md")));
    if (process.platform !== "win32") {
      assert.ok(fs.statSync(path.join(dir, "scripts", "run.sh")).mode & 0o100, "run.sh is executable");
      assert.ok(fs.statSync(path.join(dir, "scripts", "run.py")).mode & 0o100, "run.py is executable");
      assert.equal(fs.statSync(path.join(dir, "SKILL.md")).mode & 0o111, 0, "docs are not executable");
    }
  });
  it("pins a requested range and rejects an unsatisfiable one", async () => {
    assert.equal((await tai("install", "prompt", "hello@^1.0.0")).code, 0);
    assert.equal((await tai("install", "prompt", "hello@2.x")).code, 1);
  });
  it("--dry-run writes nothing", async () => {
    const r = await tai("install", "skill", "tool", "--dry-run");
    assert.equal(r.code, 0);
    assert.match(r.out, /would install skill\/tool@1\.0\.0/);
    assert.match(r.out, /would install prompt\/hello/);
    assert.deepEqual(rel(box.repo), []);
  });
  it("is idempotent", async () => {
    await tai("install", "skill", "tool");
    const again = await tai("install", "skill", "tool");
    assert.match(again.out, /up to date skill\/tool/);
    assert.doesNotMatch(again.out, /\+ /);
  });
  it("keeps an edited file as a backup when overwriting, and a foreign file too", async () => {
    await tai("install", "prompt", "hello");
    const f = inRepo(".github", "prompts", "hello.prompt.md");
    fs.writeFileSync(f, "my edit\n");
    const r = await tai("install", "prompt", "hello");
    assert.match(r.out, /kept your edited copy as \.github\/prompts\/hello\.prompt\.md\.bak-/);
    assert.equal(fs.readFileSync(f, "utf8"), "hello v1\n");
    assert.equal(rel(path.dirname(f)).filter((x) => x.includes(".bak-")).length, 1);

    fs.rmSync(inRepo(".tai.yaml"));
    fs.writeFileSync(f, "unmanaged\n");
    const r2 = await tai("install", "prompt", "hello");
    assert.match(r2.out, /kept your edited copy/);
  });
  it("does not back up an unmodified managed file on update", async () => {
    await tai("install", "prompt", "hello");
    publish({ kind: "prompt", name: "hello", version: "1.1.0", dir: "manifest/prompts", files: { "hello.prompt.md": "hello v2\n" } });
    const r = await tai("update");
    assert.doesNotMatch(r.out, /kept your edited/);
    assert.equal(fs.readFileSync(inRepo(".github", "prompts", "hello.prompt.md"), "utf8"), "hello v2\n");
  });
  it("rejects a tampered download without writing anything", async () => {
    fs.writeFileSync(path.join(box.market, "manifest", "prompts", "hello.prompt.md"), "tampered\n");
    const r = await tai("install", "prompt", "hello");
    assert.equal(r.code, 1);
    assert.match(r.err, /Integrity/);
    assert.deepEqual(rel(box.repo), []);
  });
  it("a failure midway leaves earlier assets recorded and no temp files", async () => {
    fs.rmSync(path.join(box.market, "manifest", "skills", "tool", "scripts", "run.py"));
    const r = await tai("install", "skill", "tool");
    assert.equal(r.code, 1);
    assert.deepEqual(rel(inRepo(".github", "skills")), [], "skill not partially written");
    assert.match(fs.readFileSync(inRepo(".tai.yaml"), "utf8"), /name: hello/);
    assert.doesNotMatch(fs.readFileSync(inRepo(".tai.yaml"), "utf8"), /name: tool/);
  });
});

describe("install globally", () => {
  it("writes into COPILOT_HOME with .tai.yaml beside the assets", async () => {
    for (const [k, n] of [["prompt", "hello"], ["skill", "tool"]]) {
      assert.equal((await tai("install", k, n, "-g")).code, 0);
    }
    assert.ok(fs.existsSync(inCopilot(".tai.yaml")));
    assert.ok(fs.existsSync(inCopilot("prompts", "hello.prompt.md")));
    assert.ok(fs.existsSync(inCopilot("skills", "tool", "scripts", "run.sh")));
    assert.deepEqual(rel(box.repo), []);
    assert.equal((await tai("install", "agent", "rev", "--global")).code, 0);
  });
  it("merges mcp servers and keeps the user's own", async () => {
    fs.writeFileSync(inCopilot("mcp-config.json"), JSON.stringify({ mcpServers: { mine: { url: "x" } }, other: 1 }));
    assert.equal((await tai("install", "mcp", "srv", "-g")).code, 0);
    const doc = JSON.parse(fs.readFileSync(inCopilot("mcp-config.json"), "utf8"));
    assert.deepEqual(Object.keys(doc.mcpServers).sort(), ["mine", "srv"]);
    assert.equal(doc.other, 1);
    assert.equal(doc.tai, undefined);
    assert.match(fs.readFileSync(inCopilot(".tai.yaml"), "utf8"), /servers: \["srv"\]/);
  });
  it("refuses to touch an invalid mcp-config.json", async () => {
    fs.writeFileSync(inCopilot("mcp-config.json"), "{ nope");
    const r = await tai("install", "mcp", "srv", "-g");
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(inCopilot("mcp-config.json"), "utf8"), "{ nope");
  });
  it("keeps repo and global scopes separate", async () => {
    await tai("install", "prompt", "hello");
    await tai("install", "prompt", "hello", "-g");
    await tai("uninstall", "prompt", "hello");
    assert.ok(!fs.existsSync(inRepo(".github", "prompts", "hello.prompt.md")));
    assert.ok(fs.existsSync(inCopilot("prompts", "hello.prompt.md")));
  });
});

describe("uninstall", () => {
  it("removes files, prunes empty folders, deletes an empty lock", async () => {
    await tai("install", "skill", "tool");
    await tai("uninstall", "skill", "tool");
    await tai("uninstall", "prompt", "hello");
    assert.deepEqual(rel(box.repo), [], "no files or empty folders remain");
    assert.ok(!fs.existsSync(inRepo(".github")));
  });
  it("keeps siblings and the folder they share", async () => {
    await tai("install", "prompt", "hello");
    await tai("install", "agent", "rev");
    await tai("uninstall", "prompt", "hello");
    assert.deepEqual(rel(inRepo(".github")), ["agents/rev.agent.md"]);
    assert.ok(fs.existsSync(inRepo(".tai.yaml")));
  });
  it("--dry-run changes nothing", async () => {
    await tai("install", "prompt", "hello");
    const r = await tai("uninstall", "prompt", "hello", "--dry-run");
    assert.match(r.out, /would remove prompt\/hello/);
    assert.ok(fs.existsSync(inRepo(".github", "prompts", "hello.prompt.md")));
  });
  it("preserves a user-edited file as .bak", async () => {
    await tai("install", "prompt", "hello");
    const f = inRepo(".github", "prompts", "hello.prompt.md");
    fs.writeFileSync(f, "mine\n");
    const r = await tai("uninstall", "prompt", "hello");
    assert.match(r.out, /kept your edited copy/);
    assert.ok(!fs.existsSync(f));
    assert.equal(rel(inRepo(".github", "prompts")).length, 1);
  });
  it("removes only its mcp servers, deleting the file when empty", async () => {
    await tai("install", "mcp", "srv", "-g");
    await tai("uninstall", "mcp", "srv", "-g");
    assert.ok(!fs.existsSync(inCopilot("mcp-config.json")));
    assert.ok(!fs.existsSync(inCopilot(".tai.yaml")));

    fs.writeFileSync(inCopilot("mcp-config.json"), JSON.stringify({ mcpServers: { mine: { url: "x" } } }));
    await tai("install", "mcp", "srv", "-g");
    await tai("uninstall", "mcp", "srv", "-g");
    assert.deepEqual(JSON.parse(fs.readFileSync(inCopilot("mcp-config.json"), "utf8")), { mcpServers: { mine: { url: "x" } } });
  });
  it("tells you when it is installed in the other scope, and errors when absent", async () => {
    await tai("install", "prompt", "hello", "-g");
    const r = await tai("uninstall", "prompt", "hello");
    assert.equal(r.code, 1);
    assert.match(r.err, /add -g/);
    await tai("install", "agent", "rev");
    assert.match((await tai("uninstall", "agent", "rev", "-g")).err, /drop -g/);
    assert.equal((await tai("uninstall", "agent", "zzz")).code, 1);
  });
});

describe("list", () => {
  it("lists the repo by default and global with -g, as text or json", async () => {
    await tai("install", "prompt", "hello");
    await tai("install", "agent", "rev", "-g");
    const local = (await tai("list")).out;
    assert.match(local, /prompt\/hello/);
    assert.doesNotMatch(local, /agent\/rev/);
    const global = (await tai("list", "-g")).out;
    assert.match(global, /agent\/rev/);
    assert.doesNotMatch(global, /prompt\/hello/);
    assert.deepEqual(JSON.parse((await tai("list", "--json")).out).map((x: { name: string }) => x.name), ["hello"]);
    assert.deepEqual(JSON.parse((await tai("list", "-g", "--json")).out).map((x: { scope: string }) => x.scope), ["global"]);
  });
  it("says clearly when there is no .tai.yaml, in either scope", async () => {
    for (const [args, expected] of [
      [["list"], /Nothing installed in this repo: no .*\.tai\.yaml\. Use -g for global installs\./],
      [["list", "-g"], /Nothing installed globally: no .*\.tai\.yaml\./],
    ] as const) {
      const r = await tai(...args);
      assert.equal(r.code, 0);
      assert.match(r.out, expected);
      assert.equal(r.err, "");
    }
    assert.deepEqual(JSON.parse((await tai("list", "--json")).out), []);
    assert.ok(!fs.existsSync(inRepo(".tai.yaml")), "reading creates nothing");
  });
  it("reports an empty lock file as nothing installed", async () => {
    fs.writeFileSync(inRepo(".tai.yaml"), "assets: []\n");
    assert.match((await tai("list")).out, /Nothing installed in this repo/);
  });
  it("fails clearly on an unreadable or corrupt lock, never crashes", async () => {
    fs.mkdirSync(inRepo(".tai.yaml"));
    const dir = await tai("list");
    assert.equal(dir.code, 1);
    assert.match(dir.err, /^tai: Cannot read/);
    fs.rmdirSync(inRepo(".tai.yaml"));
    fs.writeFileSync(inRepo(".tai.yaml"), "\u0000\u0001 binary");
    const bin = await tai("list");
    assert.equal(bin.code, 1);
    assert.match(bin.err, /^tai: .*\.tai\.yaml: cannot parse line 1/);
  });
  it("every read command handles a missing lock without error", async () => {
    for (const a of [["outdated"], ["doctor"], ["update"], ["outdated", "-g"], ["doctor", "-g"], ["update", "-g"]]) {
      const r = await tai(...a);
      assert.equal(r.code, 0, a.join(" "));
      assert.match(r.out, /Nothing installed/);
    }
    assert.equal((await tai("outdated", "--json")).out.trim(), "[]");
  });
  it("bare install and uninstall name the missing lock", async () => {
    const s = await tai("install");
    assert.equal(s.code, 1);
    assert.match(s.err, /Nothing to install in this repo: no .*\.tai\.yaml/);
    const u = await tai("uninstall", "prompt", "hello");
    assert.equal(u.code, 1);
    assert.match(u.err, /prompt\/hello is not installed in this repo/);
    assert.equal((await tai("install", "-g")).code, 1);
  });
});

describe("bare install restores from .tai.yaml", () => {
  it("restores a checkout from .tai.yaml, repo and global", async () => {
    await tai("install", "skill", "tool");
    await tai("install", "mcp", "srv", "-g");
    fs.rmSync(inRepo(".github"), { recursive: true });
    fs.rmSync(inCopilot("mcp-config.json"));
    const r = await tai("install");
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(inRepo(".github", "skills", "tool", "scripts", "run.sh")));
    assert.ok(fs.existsSync(inRepo(".github", "prompts", "hello.prompt.md")));
    assert.equal((await tai("install", "-g")).code, 0);
    assert.ok(fs.existsSync(inCopilot("mcp-config.json")));
  });
  it("--dry-run only reports", async () => {
    await tai("install", "prompt", "hello");
    fs.rmSync(inRepo(".github"), { recursive: true });
    assert.match((await tai("install", "--dry-run")).out, /would restore prompt\/hello@1\.0\.0/);
    assert.ok(!fs.existsSync(inRepo(".github")));
  });
  it("restores the exact pinned version, not the latest", async () => {
    await tai("install", "prompt", "hello");
    publish({ kind: "prompt", name: "hello", version: "1.1.0", dir: "manifest/prompts", files: { "hello.prompt.md": "v2\n" } });
    const r = await tai("install");
    assert.equal(r.code, 1, "1.0.0 is no longer published, so install says so");
    assert.match(r.err, /prompt\/hello@1\.0\.0/);
  });
  it("works from a hand-written .tai.yaml and uses the marketplace it records", async () => {
    fs.writeFileSync(inRepo(".tai.yaml"), `marketplace: ${JSON.stringify(box.market)}\nassets:\n  - kind: agent\n    name: rev\n    version: 1.0.0\n`);
    delete process.env.TAI_MARKETPLACE_HOME;
    const r = await tai("install");
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(inRepo(".github", "agents", "rev.agent.md")));
    assert.equal((await tai("doctor")).code, 0);
  });
});

describe("update and outdated", () => {
  beforeEach(async () => {
    await tai("install", "prompt", "hello");
    await tai("install", "agent", "rev", "-g");
  });
  it("outdated is quiet and 0 when current, 1 with detail when not", async () => {
    assert.equal((await tai("outdated")).code, 0);
    publish({ kind: "prompt", name: "hello", version: "1.2.0", dir: "manifest/prompts", files: { "hello.prompt.md": "v2\n" } });
    const r = await tai("outdated");
    assert.equal(r.code, 1);
    assert.match(r.out, /prompt\/hello\s+1\.0\.0 -> 1\.2\.0/);
    assert.doesNotMatch(r.out, /agent\/rev/);
    assert.equal((await tai("outdated", "-g")).code, 0);
    assert.equal(JSON.parse((await tai("outdated", "--json")).out)[0].latest, "1.2.0");
  });
  it("flags assets removed from the marketplace", async () => {
    published = published.filter((p) => p.name !== "rev");
    publish({ kind: "prompt", name: "hello", version: "1.0.0", dir: "manifest/prompts", files: { "hello.prompt.md": "hello v1\n" } });
    const r = await tai("outdated", "-g");
    assert.equal(r.code, 1);
    assert.match(r.out, /removed/);
  });
  it("update moves everything, one asset, or nothing under --dry-run", async () => {
    publish({ kind: "prompt", name: "hello", version: "1.2.0", dir: "manifest/prompts", files: { "hello.prompt.md": "v2\n" } });
    publish({ kind: "agent", name: "rev", version: "1.1.0", dir: "manifest/agents", files: { "rev.agent.md": "agent2\n" } });
    const dry = await tai("update", "--dry-run");
    assert.match(dry.out, /would install prompt\/hello@1\.2\.0/);
    assert.equal(fs.readFileSync(inRepo(".github", "prompts", "hello.prompt.md"), "utf8"), "hello v1\n");
    assert.equal((await tai("update", "agent", "rev", "-g")).code, 0);
    assert.equal(fs.readFileSync(inCopilot("agents", "rev.agent.md"), "utf8"), "agent2\n");
    assert.equal(fs.readFileSync(inRepo(".github", "prompts", "hello.prompt.md"), "utf8"), "hello v1\n");
    assert.equal((await tai("update")).code, 0);
    assert.equal(fs.readFileSync(inRepo(".github", "prompts", "hello.prompt.md"), "utf8"), "v2\n");
    assert.match((await tai("update")).out, /up to date/);
    assert.equal((await tai("update", "prompt", "nope")).code, 1);
  });
  it("update drops files a newer version no longer ships", async () => {
    await tai("install", "skill", "tool", "-g");
    const { "scripts/run.py": _gone, ...rest } = SCRIPT_FILES;
    publish({ kind: "skill", name: "tool", version: "1.1.0", dir: "manifest/skills/tool", files: rest });
    await tai("update", "skill", "tool", "-g");
    assert.ok(!fs.existsSync(inCopilot("skills", "tool", "scripts", "run.py")));
    assert.ok(fs.existsSync(inCopilot("skills", "tool", "scripts", "run.sh")));
  });
});

describe("doctor", () => {
  it("passes on a healthy install and fails on edits, deletions and unpublished versions", async () => {
    await tai("install", "skill", "tool");
    await tai("install", "mcp", "srv", "-g");
    const ok = await tai("doctor");
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /ok\s+skill\/tool/);

    const f = inRepo(".github", "skills", "tool", "scripts", "run.sh");
    fs.writeFileSync(f, "edited\n");
    fs.rmSync(inRepo(".github", "skills", "tool", "SKILL.md"));
    const bad = await tai("doctor");
    assert.equal(bad.code, 1);
    assert.match(bad.out, /modified: \.github\/skills\/tool\/scripts\/run\.sh/);
    assert.match(bad.out, /missing: \.github\/skills\/tool\/SKILL\.md/);

    fs.writeFileSync(inCopilot("mcp-config.json"), "{}");
    assert.match((await tai("doctor", "-g")).out, /missing mcp server: srv/);

    publish({ kind: "prompt", name: "hello", version: "1.5.0", dir: "manifest/prompts", files: { "hello.prompt.md": "x\n" } });
    assert.match((await tai("doctor")).out, /1\.0\.0 is no longer published/);
  });
  it("survives an unreachable marketplace", async () => {
    await tai("install", "prompt", "hello");
    process.env.TAI_MARKETPLACE_HOME = path.join(box.root, "gone");
    const r = await tai("doctor");
    assert.match(r.out, /warn\s+marketplace unreachable/);
    assert.equal(r.code, 0);
  });
});

describe("config and marketplace resolution", () => {
  it("set, get, unset and path, validating input", async () => {
    delete process.env.TAI_MARKETPLACE_HOME;
    assert.match((await tai("config")).out, /source:\s+default/);
    assert.equal((await tai("config", "set", "marketplace", box.market)).code, 0);
    assert.equal((await tai("config", "get", "marketplace")).out.trim(), box.market);
    assert.match((await tai("config")).out, /source:\s+config/);
    assert.ok((await tai("config", "path")).out.trim().startsWith(box.taiHome));
    assert.equal((await tai("config", "set", "marketplace", path.join(box.root, "nope"))).code, 1);
    assert.equal((await tai("config", "set", "marketplace")).code, 2);
    assert.equal((await tai("search")).code, 0);
    assert.equal((await tai("config", "unset", "marketplace")).code, 0);
    assert.match((await tai("config", "get", "marketplace")).out, /not set/);
    assert.ok(!fs.existsSync(box.taiHome), "config folder removed when empty");
  });
  it("accepts a url and a file:// location", async () => {
    assert.equal((await tai("config", "set", "marketplace", "https://example.test/m/")).code, 0);
    assert.equal((await tai("config", "get", "marketplace")).out.trim(), "https://example.test/m");
    const url = "file:///" + box.market.replace(/\\/g, "/");
    delete process.env.TAI_MARKETPLACE_HOME;
    assert.equal((await tai("search", "--marketplace", url)).code, 0);
  });
  it("precedence is flag, env, config", async () => {
    const other = path.join(box.root, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "catalog.json"), JSON.stringify({ schemaVersion: 1, assets: [] }));
    await tai("config", "set", "marketplace", other);
    assert.match((await tai("search")).out, /prompt\/hello/, "env beats config");
    assert.match((await tai("search", "--marketplace", other)).out, /No matches/, "flag beats env");
    assert.match((await tai("config", "--marketplace", other)).out, /source:\s+--marketplace/);
  });
  it("reports a corrupt config and a bad catalog", async () => {
    fs.mkdirSync(box.taiHome);
    fs.writeFileSync(path.join(box.taiHome, "config.json"), "{ nope");
    delete process.env.TAI_MARKETPLACE_HOME;
    assert.equal((await tai("search")).code, 1);
    fs.rmSync(box.taiHome, { recursive: true });
    process.env.TAI_MARKETPLACE_HOME = box.market;
    fs.writeFileSync(path.join(box.market, "catalog.json"), "not json");
    assert.equal((await tai("search")).code, 1);
    fs.writeFileSync(path.join(box.market, "catalog.json"), JSON.stringify({ schemaVersion: 9, assets: [] }));
    assert.match((await tai("search")).err, /Unsupported catalog/);
  });
  it("rejects path traversal from a hostile catalog", async () => {
    fs.writeFileSync(
      path.join(box.market, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        assets: [{ kind: "skill", name: "evil", description: "x", versions: [{ version: "1.0.0", path: "manifest/skills/evil", files: ["../../escape.txt"] }] }],
      }),
    );
    const r = await tai("install", "skill", "evil");
    assert.equal(r.code, 1);
    assert.match(r.err, /Unsafe/);
    assert.deepEqual(rel(box.repo), []);
  });
});

describe("http marketplace", () => {
  let server: http.Server;
  let base: string;
  let seen: (string | undefined)[];

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer s3cret") {
        res.writeHead(401).end();
        return;
      }
      const file = path.join(box.market, ...decodeURIComponent(req.url!).split("/").filter(Boolean));
      if (!fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    delete process.env.TAI_MARKETPLACE_HOME;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("sends the bearer token and installs binaries intact", async () => {
    process.env.TAI_TOKEN = "s3cret";
    const r = await tai("install", "skill", "tool", "--marketplace", base);
    assert.equal(r.code, 0, r.err);
    assert.ok(seen.every((h) => h === "Bearer s3cret"));
    assert.ok(fs.readFileSync(inRepo(".github", "skills", "tool", "assets", "blob.bin")).equals(SCRIPT_FILES["assets/blob.bin"]));
    assert.match(fs.readFileSync(inRepo(".tai.yaml"), "utf8"), /marketplace: "http:\/\/127\.0\.0\.1/);
    assert.equal((await tai("install")).code, 0, "bare install reuses the recorded marketplace");
  });
  it("explains 401 and 404", async () => {
    const r = await tai("search", "--marketplace", base);
    assert.equal(r.code, 1);
    assert.match(r.err, /HTTP 401.*TAI_TOKEN/);
    process.env.TAI_TOKEN = "s3cret";
    fs.rmSync(path.join(box.market, "manifest", "prompts", "hello.prompt.md"));
    const r2 = await tai("install", "prompt", "hello", "--marketplace", base);
    assert.match(r2.err, /HTTP 404/);
    assert.deepEqual(rel(box.repo), []);
  });
  it("refuses to send the token over plain http to a remote host", async () => {
    process.env.TAI_TOKEN = "s3cret";
    const r = await tai("search", "--marketplace", "http://example.test");
    assert.equal(r.code, 1);
    assert.match(r.err, /plain http/);
  });
  it("reports an unreachable host", async () => {
    const r = await tai("search", "--marketplace", "http://127.0.0.1:1");
    assert.equal(r.code, 1);
    assert.match(r.err, /Cannot reach/);
  });
});
