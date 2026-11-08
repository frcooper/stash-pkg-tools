# stash-pkg-tools

Build tooling for repos that publish Stash plugins or scrapers as a package source: it validates each package, builds the `index.yml` and zips Stash installs from, enforces version bumps, and tags releases.

## Use in a package repo

The repo keeps one directory per package under `plugins/` or `scrapers/`, each with `<Id>.yml` and a `CHANGELOG.md`.

`package.json`:

```json
{
  "type": "module",
  "stashPackages": "plugin",
  "scripts": {
    "validate": "stash-pkg validate",
    "build": "stash-pkg build",
    "check-versions": "stash-pkg check-versions",
    "tag-releases": "stash-pkg tag-releases"
  },
  "devDependencies": {
    "stash-pkg-tools": "git+https://github.com/frcooper/stash-pkg-tools.git#v1.0.0"
  }
}
```

Set `stashPackages` to `"plugin"` or `"scraper"`.

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  deploy:
    uses: frcooper/stash-pkg-tools/.github/workflows/deploy.yml@v1.0.0
    permissions:
      contents: write
```

Keep the CI workflow in the package repo itself: its job name is the required status check, and a reusable workflow would rename it.

## Commands

| Command | What it does |
|---|---|
| `stash-pkg validate` | Checks every package is well-formed. |
| `stash-pkg build [outdir]` | Validates, then writes `index.yml` and one zip per package (default `_site`). |
| `stash-pkg check-versions <base>` | Fails if a package changed since `<base>` without its version going up. |
| `stash-pkg tag-releases` | Tags HEAD as `<Id>/v<version>` for each version without a tag. |

## Plugins and scrapers

| | Plugin | Scraper |
|---|---|---|
| Folder | `plugins/` | `scrapers/` |
| Version | `version:` in the yml, with a matching `## x.y.z` in CHANGELOG.md | first `## x.y.z` in CHANGELOG.md, because Stash rejects unknown scraper yml keys |
| Extra checks | `name`, `description`, `version` required; `ui` files exist; `.js` files pass `node --check` | `name` required; only keys Stash accepts |
| Index metadata | `description`, `url`, `commit` | `commit` |

Shared behaviour lives in `lib/commands.mjs`; per-kind differences are in `lib/kinds.mjs`.

## Releasing a change

Tag a new version (`v1.0.1`, `v1.1.0`, ...) and bump both the `devDependencies` ref and the workflow `@ref` in each package repo. The output of `build` should stay byte-identical unless the change is meant to alter it.
