import { execFileSync } from "node:child_process";
import fs from "node:fs";

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SUBJECT = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
const SECTIONS = [
  ["breaking", "Breaking changes"],
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const parse = (v) => v.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function lastTag() {
  const tags = git("tag", "--list", "v*").split("\n").filter((t) => TAG.test(t));
  return tags.sort((a, b) => compare(parse(a), parse(b))).pop() ?? null;
}

function commitsSince(tag) {
  const out = git("log", "--format=%h%x1f%s%x1f%b%x1e", tag ? `${tag}..HEAD` : "HEAD");
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body = ""] = r.split("\x1f");
      const m = SUBJECT.exec(subject);
      const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
      return { sha, subject, type: m?.[1], scope: m?.[2], text: m?.[4] ?? subject, breaking };
    });
}

function levelOf(commits) {
  if (commits.some((c) => c.breaking)) return "major";
  if (commits.some((c) => c.type === "feat")) return "minor";
  if (commits.some((c) => c.type === "fix" || c.type === "perf")) return "patch";
  return null;
}

function bump(base, level, auto) {
  const [major, minor, patch] = base;
  if (level === "major") return major === 0 && auto ? [0, minor + 1, 0] : [major + 1, 0, 0];
  if (level === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

function notes(commits) {
  const lines = [];
  for (const [key, title] of SECTIONS) {
    const items = commits.filter((c) => (key === "breaking" ? c.breaking : c.type === key && !c.breaking));
    if (!items.length) continue;
    lines.push(`## ${title}`, ...items.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ""}${c.text} (${c.sha})`), "");
  }
  return lines.join("\n") || "Initial release.\n";
}

const requested = flag("bump", "auto");
if (!["auto", "major", "minor", "patch"].includes(requested)) fail(`unknown bump "${requested}"`);

const tag = lastTag();
const commits = commitsSince(tag);
let version;

if (!tag) {
  version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
} else {
  const level = requested === "auto" ? levelOf(commits) : requested;
  if (!level) fail(`no feat, fix, perf or breaking commits since ${tag}; pass an explicit bump to override`);
  version = bump(parse(tag), level, requested === "auto").join(".");
}

if (git("tag", "--list", `v${version}`)) fail(`tag v${version} already exists`);

const notesFile = flag("notes");
if (notesFile) fs.writeFileSync(notesFile, notes(commits));
console.log(version);
