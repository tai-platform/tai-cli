# TAI CLI

Package manager for Copilot assets: prompts, skills, instructions, and agents.

## Quick Start

1. Install dependencies:

   npm install

2. Build:

   npm run build

3. Try:

   node dist/bin/tai.js --help

## Versions and ranges

`tai install <kind> <name>@<range>` and catalog `dependencies[].version` both
accept semver ranges; the highest matching catalog version wins, and the
resolved concrete version is what lands in `.tai.yaml`.

| Range | Matches |
| --- | --- |
| `1.2.0` | exactly 1.2.0 |
| `^1.2.0` | >=1.2.0 <2.0.0 (npm rules for 0.x: `^0.2.3` stays inside 0.2) |
| `~1.2.0` | >=1.2.0 <1.3.0 |
| `1.x`, `1.2.x` | any patch/minor inside that line |
| `>=1.0.0 <2.0.0` | both comparators (space = AND) |
| `^1.0.0 \|\| ^3.0.0` | either clause |
| `*`, omitted | latest published |

    tai install skill service-craft@^2.0.0
    tai install prompt rest-controller@'>=1.0.0 <2.0.0'

Resolution is per asset, once: if a transitive dependency demands a range that
excludes the version already chosen for it, the install fails with a version
conflict instead of silently downgrading. Dependency cycles are tolerated.

## Exploring an asset

    tai explore skill/service-craft          # latest, metadata + 20-line preview
    tai explore skill/service-craft@^1.0.0   # highest 1.x
    tai explore skill service-craft --full   # whole content file
    tai explore skill/service-craft -n       # metadata only, no content fetch

Shows description, owner, maturity, SDLC phase, tags, every published version,
the source path in the catalog repo, where it installs to locally, and the
dependency list with the version each range resolves to.

## Where assets come from

Assets are read from a GitHub repo over `raw.githubusercontent.com`, with a
sparse `git clone` fallback for private repos that raw can't serve:

    https://raw.githubusercontent.com/<TAI_SOURCE>/<TAI_REF>/<TAI_CATALOG_PATH>
    https://raw.githubusercontent.com/<TAI_SOURCE>/<TAI_REF>/<asset.path>/<content file>

All of it is configurable by environment variable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAI_SOURCE` | `tai-platform/tai-marketplace` | Asset repo, as `owner/repo` |
| `TAI_REF` | `main` | Branch or tag to read from |
| `TAI_CATALOG_PATH` | `app/public/catalog.json` | Repo-relative path to the catalog |
| `TAI_TOKEN` | — | Token for private repos; falls back to `GITHUB_TOKEN`, then `gh auth token`, then `git credential fill` |

`TAI_REF` may be a commit SHA for the raw path, but the git fallback needs a
branch or tag.

Example against a fork:

    TAI_SOURCE=my-org/my-marketplace TAI_REF=develop tai search api
