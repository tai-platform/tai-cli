# Releasing

Releases are cut by the **Release** workflow, never from a laptop. Nobody pushes
tags by hand: the workflow publishes to npm, then creates the `v*` tag and the
GitHub Release itself.

## Commit convention

Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org).
Squash merging is used, so the PR title becomes the commit message and the
`PR title` check enforces the format.

| Commit | Effect on the next version |
| --- | --- |
| `fix: ...`, `perf: ...` | patch |
| `feat: ...` | minor |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major (minor while below 1.0.0) |
| `docs`, `test`, `ci`, `chore`, `refactor`, `build` | no release on their own |

The first release publishes the version in `package.json` (0.1.0). After that the
version always comes from the last `v*` tag plus the commits since. `package.json`
is not edited on `main`; the workflow sets the version in the runner before publishing.

## Cut a release

1. Actions, **Release**, Run workflow, branch `main`.
2. Leave `dry_run` on first. The run summary shows the next version and the notes.
3. Run again with `dry_run` off. A release manager approves the `npm-release`
   environment, then the workflow tests, publishes with provenance, tags the
   commit and creates the GitHub Release.

`bump` defaults to `auto`. Choose `patch`, `minor` or `major` to override, for
example `major` to graduate to 1.0.0.

## One time GitHub setup

1. Organization, Teams, New team `release-managers`. Add people there to grant release rights.
2. Repository, Settings, Collaborators and teams: give the team **Maintain**.
3. Environments, New environment `npm-release`: required reviewers = `release-managers`,
   deployment branches = `main`, secret `NPM_TOKEN` (npm automation token scoped to `@tai-platform`).
4. Rulesets: import [`.github/rulesets/release-tags.json`](../.github/rulesets/release-tags.json)
   so published tags can never be moved or deleted. Add a branch ruleset on `main`
   requiring a PR, the `test` and `conventional` checks, and no force pushes.
5. Actions, General, Workflow permissions: read repository contents by default.
   The workflow asks for write only in the publish job.
6. Turn on 2FA for the npm account.

Only people with write access can start a workflow, and nothing is published
until a release manager approves the environment.

## If something fails

The plan job fails fast when there is nothing releasable or the tag exists. Fix
forward with a new version. Never move or delete a published tag.
