# askrjs/actions

Reusable GitHub Actions for npm package repositories.

## What this repo provides

- `actions/create-tag` — create a git tag from the current `package.json` version and push it to `origin`
- `actions/create-release` — create a GitHub release from an existing semver tag
- `actions/publish-package` — publish an npm package with provenance support using OIDC or an npm token

## Usage

### Create a tag from package version

```yaml
uses: ./actions/create-tag
with:
  package-json-path: package.json
  tag-prefix: v
  git-user-name: github-actions[bot]
  git-user-email: github-actions[bot]@users.noreply.github.com
  tag-message: Release version from package.json
```

### Create a release from a tag

```yaml
uses: ./actions/create-release
with:
  tag: v1.2.3
  body: "Release created from package version tag"
  github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Publish a package to npm

```yaml
uses: ./actions/publish-package
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

## Notes

- These are composite actions and do not require repository JavaScript dependencies.
- The repo intentionally stays minimal: action metadata, docs, and Dependabot config only.
