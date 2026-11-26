# tai

Static CLI that fetches Copilot assets (prompts, skills, instructions, agents)
from a marketplace and installs them per repository or globally in your user
Copilot directory.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

The CLI holds no catalog. Everything it installs comes from a marketplace, by
default [tai-marketplace](https://github.com/tai-platform/tai-marketplace),
published as a static site. Add or change assets there and every `tai` user
gets them on the next fetch.

## Install

```bash
npm install -g @tai-platform/tai
tai --help
```

Requires Node.js 20 or later.

## Quick start

```bash
tai search review                         # find assets
tai view agent code-reviewer              # metadata, files, installed status, definition
tai install agent code-reviewer           # into this repo: .github/agents/
tai install skill service-craft@^1.0.0    # dependencies come along
tai install mcp atlassian -g              # into ~/.copilot
tai list                                  # what is installed in this repo (-g for global)
tai outdated                              # anything newer published?
tai update                                # move to latest
tai install                               # restore exactly what .tai.yaml records
tai doctor                                # verify files on disk
```

## Commands

| Command | Purpose |
| --- | --- |
| `tai search [query] [-k kind] [--json]` | Search the catalog; installed assets are marked |
| `tai view <kind> <name>[@range] [--raw] [--json]` | Details and the definition; `--raw` prints only the definition |
| `tai install [<kind> <name>[@range]] [-g] [--dry-run]` | Install an asset and its dependencies; with no asset, restore everything in `.tai.yaml` |
| `tai uninstall <kind> <name> [-g] [--dry-run]` | Remove an asset and the folders it leaves empty |
| `tai list [-g] [--json]` | Installed assets from `.tai.yaml` |
| `tai update [<kind> <name>] [-g] [--dry-run]` | Move to the latest published version |
| `tai outdated [-g] [--json]` | Show newer versions, exit 1 if any |
| `tai doctor [-g]` | Check files against `.tai.yaml`, exit 1 on problems |
| `tai config [get\|set\|unset\|path] [marketplace] [value]` | Manage the marketplace |

Kinds: `prompt`, `skill`, `instruction`, `agent`, `mcp`. Assets are always named
with a space, `<kind> <name>`. There is no shared `copilot-instructions.md` kind:
that file holds one team's own rules, so each team writes its own.

Global options: `--marketplace <url|dir>` for one run, `-h`/`--help` (also per
command), `--version`. `-g`/`--global` targets `~/.copilot`; without it, commands
that change things act on the current repository. `--dry-run` prints the plan and
writes nothing. Exit codes: 0 success, 1 failure or findings, 2 usage error.

`uninstall` removes only the asset you name. Dependencies stay until you
uninstall them.

## Where files go

| Kind | Per repository | With `--global` |
| --- | --- | --- |
| prompt | `.github/prompts/<name>.prompt.md` | `~/.copilot/prompts/` |
| instruction | `.github/instructions/<name>.instructions.md` | `~/.copilot/instructions/` |
| agent | `.github/agents/<name>.agent.md` | `~/.copilot/agents/` |
| skill | `.github/skills/<name>/` | `~/.copilot/skills/` |
| mcp | not supported | merged into `~/.copilot/mcp-config.json` |

The layout mirrors `~/.copilot`, which can be relocated with `COPILOT_HOME`.
`mcp` servers are merged, so personal servers survive and `tai uninstall` removes
only what tai added.

## What is installed, and where tai remembers it

`.tai.yaml` is the source of truth. A repository install is recorded in
`<repo>/.tai.yaml` (commit it, teammates run `tai install`). A global install is
recorded in `~/.copilot/.tai.yaml`, next to the assets. Each entry holds the
version and the SHA-256 of every file written:

```yaml
marketplace: "https://tai.internal.example.com"
assets:
  - kind: skill
    name: service-craft
    version: 1.0.0
    files:
      - "<sha256> .github/skills/service-craft/SKILL.md"
```

The format is a small YAML subset you can edit by hand. A minimal entry with
`kind`, `name` and `version` is enough for `tai install` to rebuild the rest.
A corrupt file is an error, never silently treated as empty. The
`marketplace` line pins the source for teammates unless they override it.

## Skills with helper scripts

A skill is a folder and may ship anything beside `SKILL.md`: shell, Python,
PowerShell or `.cmd` helpers, data files, binaries. tai copies every file byte
for byte, verified against the catalog hash, and marks `.sh`, `.py`, `.pl`, `.rb`
and shebang files executable on macOS and Linux. **tai never runs them.** You or
Copilot run them, after you have read them.

## Safe on your machine

- Everything is downloaded and verified in memory first. Nothing is extracted to a temporary folder.
- Each file is written to a `.tai-tmp-<pid>` sibling and renamed, and removed again on failure.
- A file you edited, or that tai did not create, is moved to `<file>.bak-<timestamp>` before it is replaced or removed.
- Uninstall removes empty folders it leaves behind, and deletes `.tai.yaml` when it becomes empty.
- Downloads are capped at 10 MB per file.

## Marketplace

One global constant, `MARKETPLACE_HOME` in [`src/constants.ts`](src/constants.ts),
names the default marketplace. Override order:

1. `--marketplace <url|dir>`
2. `TAI_MARKETPLACE_HOME`
3. `tai config set marketplace <url|dir>` (validated when set)
4. Built-in `MARKETPLACE_HOME`

A marketplace is an `https://` base URL or a local directory serving
`catalog.json` and the files it lists. The format is documented in
[tai-marketplace](https://github.com/tai-platform/tai-marketplace).

```bash
# Private marketplace
export TAI_MARKETPLACE_HOME=https://tai.internal.example.com
export TAI_TOKEN=<token>        # Bearer token, sent only to that host

# Local checkout
tai config set marketplace ./tai-marketplace/app/site
```

## Versions and ranges

`tai install <kind> <name>@<range>` and catalog dependency versions accept
semver ranges. The highest match wins and the concrete version lands in `.tai.yaml`.

| Range | Matches |
| --- | --- |
| `1.2.0` | exactly 1.2.0 |
| `^1.2.0` | `>=1.2.0 <2.0.0` (npm rules for 0.x) |
| `~1.2.0` | `>=1.2.0 <1.3.0` |
| `1.x`, `1.2.x` | any version in that line |
| `>=1.0.0 <2.0.0` | both comparators |
| `^1.0.0 \|\| ^3.0.0` | either clause |
| `*`, omitted | latest |

Each asset is resolved once. A dependency range that excludes the version
already chosen fails with a version conflict instead of downgrading. Cycles are tolerated.
Ranges are handled by a small built-in implementation: tai has **zero runtime
dependencies**, so there is nothing to scan and nothing to patch downstream.

## Security

Downloads are verified against the SHA-256 in the catalog, names and paths are
checked against traversal, and `TAI_TOKEN` is never sent over plain http. Prompts,
agents and MCP servers steer an assistant that runs tools, so install only from
marketplaces you trust. Details in [SECURITY.md](SECURITY.md).

## Environment

| Variable | Purpose |
| --- | --- |
| `TAI_MARKETPLACE_HOME` | Marketplace URL or directory |
| `TAI_TOKEN` | Bearer token for private marketplaces |
| `TAI_HOME` | Config directory, default `~/.tai` |
| `COPILOT_HOME` | Copilot user directory, default `~/.copilot` |

## Develop

```bash
npm install
npm test
node dist/bin/tai.js --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASING.md](docs/RELEASING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
