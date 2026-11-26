import { type Catalog, type AssetVersion, findAsset, pickVersion } from "./catalog.js";
import type { Kind } from "./constants.js";
import { TaiError } from "./errors.js";
import * as semver from "./semver.js";

export interface Resolved {
  kind: Kind;
  name: string;
  version: AssetVersion;
}

const key = (kind: Kind, name: string) => `${kind}/${name}`;

export function resolveTree(
  cat: Catalog,
  kind: Kind,
  name: string,
  range?: string,
  chosen: Map<string, Resolved> = new Map(),
  requiredBy = "root",
): Map<string, Resolved> {
  const k = key(kind, name);
  const existing = chosen.get(k);
  if (existing) {
    const r = !range || range === "latest" ? "*" : range;
    if (!semver.satisfies(existing.version.version, r)) {
      throw new TaiError(
        `Version conflict on ${k}: ${existing.version.version} already chosen, ${requiredBy} needs "${r}"`,
      );
    }
    return chosen;
  }
  const asset = findAsset(cat, kind, name);
  const version = pickVersion(asset, range);
  chosen.set(k, { kind, name, version });
  for (const dep of version.dependencies ?? []) {
    resolveTree(cat, dep.kind, dep.name, dep.version, chosen, `${k}@${version.version}`);
  }
  return chosen;
}

export function parseSpec(spec: string): { name: string; range?: string } {
  const i = spec.indexOf("@");
  if (i <= 0) return { name: spec };
  return { name: spec.slice(0, i), range: spec.slice(i + 1) || undefined };
}
