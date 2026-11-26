# Publishing to npm

## One time setup

1. Create the npm organization `tai-platform` (or change the scope in `package.json`).
2. Enable 2FA on your npm account.
3. Create an automation token with publish rights and save it as the
   `NPM_TOKEN` secret in the GitHub repository.
4. Confirm `repository.url` in `package.json` matches the real repository.

## Dry run

```bash
npm ci
npm test
npm pack --dry-run
```

The tarball must contain only `dist/`, `LICENSE`, `NOTICE`, `README.md` and `package.json`.

## Release

See [RELEASING.md](RELEASING.md) for the protected process and the one time GitHub setup.

```bash
npm version patch          # or minor, major; creates a commit and a v* tag
git push origin main --follow-tags
```

Manual publish, only if the workflow is unavailable:

```bash
npm login
npm publish --access public
```

## First release checklist

- [ ] `npm test` passes on Node 20 and 22
- [ ] `npm whoami` shows your account, and `npm view @tai-platform/tai` returns 404 (name is free)
- [ ] `MARKETPLACE_HOME` in `src/constants.ts` points at the live Pages site
- [ ] `repository.url` and the LICENSE holder are real
- [ ] `npm pack --dry-run` content is correct
- [ ] `npm install -g ./tai-platform-tai-0.1.0.tgz` then `tai --help` works
- [ ] Tag `v0.1.0` and publish

## Order for the very first ship

1. Publish the marketplace first: push `tai-marketplace` to GitHub, enable Pages
   (Settings, Pages, Source: GitHub Actions), run the "Publish catalog" workflow.
2. Check `<pages-url>/catalog.json` loads, then set `MARKETPLACE_HOME` to that URL.
3. Rebuild and run `npm test`.
4. Publish the CLI. Manual first publish: `npm login`, `npm publish --access public`.
5. Smoke test from a clean machine: `npm i -g @tai-platform/tai && tai search`.
