import { CATALOG_FILE, KINDS, NAME_RE, type Kind } from "./constants.js";
import { TaiError } from "./errors.js";
import * as semver from "./semver.js";
import { readText } from "./source.js";

export interface Dependency {
  kind: Kind;
  name: string;
  version?: string;
}

export interface AssetVersion {
  version: string;
  path: string;
  files: string[];
  integrity?: Record<string, string>;
  dependencies?: Dependency[];
}

export interface Asset {
  kind: Kind;
  name: string;
  description: string;
  author?: string | null;
  contributors?: { login: string; commits: number }[];
  createdAt?: string | null;
  updatedAt?: string | null;
  maturity?: string;
  phase?: string;
  tags?: string[];
  versions: AssetVersion[];
}

export interface Catalog {
  schemaVersion: number;
  generatedAt?: string;
  assets: Asset[];
}

export async function loadCatalog(home: string): Promise<Catalog> {
  const text = await readText(home, CATALOG_FILE);
  let cat: Catalog;
  try {
    cat = JSON.parse(text) as Catalog;
  } catch {
    throw new TaiError(`${CATALOG_FILE} at ${home} is not valid JSON`);
  }
  if (cat.schemaVersion !== 1 || !Array.isArray(cat.assets)) {
    throw new TaiError(`Unsupported catalog (schemaVersion ${cat.schemaVersion}); upgrade tai`);
  }
  return cat;
}

export function parseKind(value: string): Kind {
  if ((KINDS as readonly string[]).includes(value)) return value as Kind;
  throw new TaiError(`Unknown kind "${value}". Use one of: ${KINDS.join(", ")}`);
}

export function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new TaiError(`Unsafe asset name "${name}"`);
}

export function findAsset(cat: Catalog, kind: Kind, name: string): Asset {
  const a = cat.assets.find((x) => x.kind === kind && x.name === name);
  if (!a) throw new TaiError(`Not found: ${kind}/${name}`);
  return a;
}

export function latestVersion(asset: Asset): AssetVersion {
  return pickVersion(asset);
}

export function pickVersion(asset: Asset, range?: string): AssetVersion {
  const valid = asset.versions.filter((v) => semver.valid(v.version));
  const r = !range || range === "latest" ? "*" : range;
  const best = semver.maxSatisfying(
    valid.map((v) => v.version),
    r,
  );
  if (!best) {
    const have = valid.map((v) => v.version).join(", ") || "none";
    throw new TaiError(`No version of ${asset.kind}/${asset.name} matches "${r}" (published: ${have})`);
  }
  return valid.find((v) => v.version === best)!;
}

export function search(cat: Catalog, query: string, kind?: Kind): Asset[] {
  const q = query.toLowerCase();
  return cat.assets
    .filter((a) => !kind || a.kind === kind)
    .filter(
      (a) =>
        !q ||
        [a.name, a.description, a.author ?? "", a.phase ?? "", ...(a.tags ?? [])].some((s) =>
          s.toLowerCase().includes(q),
        ),
    )
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
