# Releasing

Only release managers can create a release. Three layers enforce it.

## One time GitHub setup

1. Organization, Teams, New team: `release-managers`. Add yourself as maintainer.
   Add people later from the same page; membership is the only thing to manage.
2. Repository, Settings, Collaborators and teams: give `release-managers` the
   **Maintain** role (Write is the minimum that can push tags).
3. Repository, Settings, Rules, Rulesets, New ruleset, Import a ruleset: upload
   [`.github/rulesets/release-tags.json`](../.github/rulesets/release-tags.json).
   Then edit it and add `release-managers` (or the Repository admin role) to
   **Bypass list**, mode "Always". Nobody outside the list can create, move or
   delete a `v*` tag, even with Write access.
4. Repository, Settings, Rules, Rulesets: add a branch ruleset on `main` that
   requires a pull request, the `test` status checks, and blocks force pushes.
5. Repository, Settings, Environments, New environment `npm-release`: tick
   "Required reviewers" and select `release-managers`; restrict deployment to
   tags matching `v*`. Move `NPM_TOKEN` here as an environment secret if you want
   only this job to ever read it (it is an org secret scoped to this repo today).
6. npm: use an automation token scoped to the `@tai-platform` packages, with 2FA
   on the account.

## Cut a release

```bash
git switch main && git pull
npm version patch            # or minor, major: bumps package.json, commits, tags
git push origin main --follow-tags
```

The `Release` workflow then checks that the tag equals `package.json`, that the
tagged commit is on `main`, runs the tests, waits for a release manager to
approve the `npm-release` environment, and publishes with provenance.

## If something fails

A failed publish never half ships: tests and checks run first. Fix forward with a
new patch version. Do not move or delete a published tag.
