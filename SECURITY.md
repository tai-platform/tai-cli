# Security Policy

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting on this
repository (Security tab, Report a vulnerability). You will get an answer within
five working days.

## What tai defends against

- **Path traversal.** Asset names must match `^[a-z0-9][a-z0-9-]*$` and marketplace paths may not contain `..`, so a hostile catalog cannot write outside the install directories.
- **Tampering.** When the catalog lists `sha256` integrity for a file, tai verifies it before writing anything. A mismatch aborts the install.
- **Token leakage.** `TAI_TOKEN` is never sent over plain http, except to localhost.
- **Partial installs.** Files are downloaded and verified in memory first, then each is written through a temp sibling and renamed. A failure leaves no temp files.
- **Config clobbering.** Edited or unmanaged files are saved as `.bak-<timestamp>` before replacement, and `mcp-config.json` is merged, never overwritten.
- **Supply chain.** tai has zero runtime dependencies. Downloads are capped at 10 MB per file.

## Helper scripts

Skills can ship shell, Python, PowerShell and `.cmd` helpers. tai copies them
verified and sets the executable bit on POSIX, but never executes anything it
downloads.

## What it does not defend against

A marketplace you choose to trust can ship any prompt, agent or MCP server. They
steer a coding assistant that can run tools. Review what you install, and
only point tai at marketplaces you control or trust.
