# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com) and the project uses
[Semantic Versioning](https://semver.org).

## [0.1.0] - Unreleased

### Added

- Commands: `search`, `view`, `install`, `uninstall`, `list`, `update`, `outdated`, `doctor`, `config`.
- Five asset kinds mirroring `~/.copilot`: `prompt`, `skill`, `instruction`, `agent`, `mcp`.
- Per repository and `--global` installs, tracked with per-file SHA-256 in `.tai.yaml` (repo root, or `~/.copilot/.tai.yaml`).
- `--json` on read commands and `--dry-run` on write commands. Every command works on the current repo unless `-g` is given.
- A missing `.tai.yaml` gives a plain "Nothing installed" message, never a crash; a corrupt one names the file and line.
- Skills may carry helper scripts and binaries in any language; files are copied byte for byte and never executed.
- Edited or unmanaged files are kept as `.bak-<timestamp>`; uninstall prunes empty folders and an empty lock.
- Semver ranges with transitive dependency resolution and conflict detection.
- Configurable marketplace through `MARKETPLACE_HOME`, `--marketplace`, `TAI_MARKETPLACE_HOME` and `tai config`.
- Private marketplaces through `TAI_TOKEN`.
- SHA-256 integrity verification, path traversal guards, a 10 MB file cap, and safe MCP merge.
- Zero runtime dependencies.
