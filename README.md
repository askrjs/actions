# askrjs/actions

Reusable GitHub Actions for npm package repositories.

## What this repo provides

- `actions/create-tag` — create a git tag from the current `package.json` version and push it to `origin`
- `actions/create-release` — create a GitHub release from an existing semver tag
- `actions/publish-package` — publish an npm package with provenance support using OIDC or an npm token
- `actions/validate-semver` — validate a semver major.minor.patch value with optional `v` prefix support
- `actions/validate-package-version` — ensure a package.json version matches a release tag
- `actions/resolve-npm-tag` — map a semver tag to an npm dist-tag

## Usage

These composite actions are intended to be consumed directly from this public
repo. Workflows that use the git-based actions must check out the target
repository, and workflows that read package metadata must provide a Node.js
runtime. The actions are intentionally standalone and do not call other shared
actions.

### Create a tag from package version

```yaml
uses: askrjs/actions/actions/create-tag@main
with:
  package-json-path: package.json
  tag-prefix: v
  git-user-name: github-actions[bot]
  git-user-email: github-actions[bot]@users.noreply.github.com
  tag-message: Release version from package.json
```

### Create a release from a tag

```yaml
uses: askrjs/actions/actions/create-release@main
with:
  tag: v1.2.3
  body: "Release created from package version tag"
  github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Validate a semver value

```yaml
uses: askrjs/actions/actions/validate-semver@main
with:
  semver: v1.2.3
```

### Validate a package version against a tag

```yaml
uses: askrjs/actions/actions/validate-package-version@main
with:
  package-json-path: package.json
  tag: v1.2.3
```

### Resolve an npm dist-tag

```yaml
uses: askrjs/actions/actions/resolve-npm-tag@main
with:
  semver: v1.2.3-beta.1
```

### Publish a package to npm

```yaml
uses: askrjs/actions/actions/publish-package@main
with:
  package-json-path: package.json
  registry: https://registry.npmjs.org/
  access: public
  tag: latest
  npm-token: ${{ secrets.NPM_TOKEN }}
```

For OIDC-based publish, omit `npm-token` and ensure the workflow has `permissions.id-token: write`.

## Action permissions

- `actions/create-tag` requires `contents: write` to push tags
- `actions/create-release` requires `contents: write` to create releases
- `actions/publish-package` requires `id-token: write` for OIDC publishing
- `actions/validate-semver` has no special permissions requirements
- `actions/validate-package-version` has no special permissions requirements
- `actions/resolve-npm-tag` has no special permissions requirements

## Notes

- These are composite actions and do not require repository JavaScript dependencies.
- `actions/create-release` uses the GitHub CLI and expects `gh` to be available on the runner.
- The repo intentionally stays minimal: action metadata, docs, and Dependabot config only.
