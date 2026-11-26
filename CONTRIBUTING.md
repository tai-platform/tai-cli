# Contributing

1. Fork and branch from `main`.
2. `npm install`, make the change, add a focused test in `test/`.
3. `npm test` must pass.
4. Open a pull request describing the behavior change. The title must follow
   [Conventional Commits](https://www.conventionalcommits.org), for example
   `feat(cli): add view command` or `fix(install): keep edited files`. PRs are
   squash merged, so the title decides the next version.

By contributing you agree your work is licensed under the Apache License 2.0.
To share prompts, skills, instructions or agents, contribute to
[tai-marketplace](https://github.com/tai-platform/tai-marketplace) instead.

## Commit convention

| Commit | Effect on the next version |
| --- | --- |
| `fix: ...`, `perf: ...` | patch |
| `feat: ...` | minor |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major (minor while below 1.0.0) |
| `docs`, `test`, `ci`, `chore`, `refactor`, `build` | no release on their own |

## Releasing

For release managers. Releases come from the **Release** workflow, never from a
laptop. Nobody pushes tags by hand: the workflow publishes to npm, then creates
the `v*` tag and the GitHub Release.

1. Actions, **Release**, Run workflow, branch `main`.
2. Leave `dry_run` on first. The summary shows the next version and the notes.
3. Run again with `dry_run` off. A release manager approves the `npm-release`
   environment, then the workflow tests, publishes with provenance, tags and releases.

The first release publishes the version in `package.json`. After that the version
is the last `v*` tag plus the commits since. `bump` overrides `auto` with `patch`,
`minor` or `major`. If nothing releasable landed, the run fails fast. Fix forward
with a new version and never move or delete a published tag.

### One time GitHub setup

1. Organization, Teams: create `release-managers` and give it **Maintain** on the repository.
2. Environment `npm-release`: required reviewers `release-managers`, deployment
   branches `main`, secret `NPM_TOKEN` (npm automation token scoped to `@tai-platform`).
3. Rulesets: import [`.github/rulesets/release-tags.json`](.github/rulesets/release-tags.json)
   so published tags cannot be moved or deleted. Protect `main` with a PR rule
   requiring the `test` and `conventional` checks and no force pushes.
4. Actions, General: default workflow permissions read only.
5. Enable 2FA on the npm account.

### First ship

1. Publish [tai-marketplace](https://github.com/tai-platform/tai-marketplace) and
   enable Pages (Source: GitHub Actions).
2. Check `<pages-url>/catalog.json` loads and `MARKETPLACE_HOME` in
   `src/constants.ts` points at it.
3. Run the Release workflow, dry run first.
4. Smoke test on a clean machine: `npm i -g @tai-platform/tai && tai search`.
