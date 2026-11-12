# stash-pkg-tools

Build tooling for repos that publish Stash plugins, themes or scrapers as a package source: it validates each package, works out each package's version from git, builds the `index.yml` and zips Stash installs from, and tags releases.

## Use in a package repo

The repo keeps one directory per package under `plugins/`, `themes/` or `scrapers/`, each with `<Id>.yml` and a `CHANGELOG.md`. Package ymls carry no `version:`: see [Versions](#versions).

`package.json`:

```json
{
  "type": "module",
  "stashPackages": "plugin",
  "scripts": {
    "validate": "stash-pkg validate",
    "build": "stash-pkg build",
    "plan": "stash-pkg plan",
    "tag-releases": "stash-pkg tag-releases"
  },
  "devDependencies": {
    "stash-pkg-tools": "git+https://github.com/frcooper/stash-pkg-tools.git#v2.0.0"
  }
}
```

Set `stashPackages` to `"plugin"`, `"theme"` or `"scraper"`.

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
    uses: frcooper/stash-pkg-tools/.github/workflows/deploy.yml@v2.0.0
    permissions:
      contents: write
```

Keep the CI workflow in the package repo itself: its job name is the required status check, and a reusable workflow would rename it. On pull requests it should check the title and show what would release:

```yaml
      - run: npx stash-pkg check-title "$PR_TITLE"
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
      - run: npx stash-pkg plan ${{ github.event.pull_request.base.sha }} "$PR_TITLE"
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
      - run: npx stash-pkg build
```

Set the repo to squash merge with the PR title and body as the commit (`squash_merge_commit_title: PR_TITLE`, `squash_merge_commit_message: PR_BODY`), so `main` records each PR's type and changelog.

## Commands

| Command | What it does |
|---|---|
| `stash-pkg validate` | Checks every package is well-formed. |
| `stash-pkg build [outdir]` | Validates, then writes `index.yml` and one zip per package (default `_site`). With no packages yet, the index is an empty list. |
| `stash-pkg plan [base] [title]` | Prints the version each package changed since `<base>` releases as. With a PR title, counts it as the commit the PR will add. |
| `stash-pkg check-title <title>` | Fails unless the title is a Conventional Commit, e.g. `fix(Insights): keep the calendar in local time`. |
| `stash-pkg tag-releases` | Tags HEAD as `<Id>/v<version>` for each package this build released. |

## Plugins, themes and scrapers

Stash has no theme package type: a theme is a plugin that ships CSS, installed from a plugin source. The `theme` kind applies the plugin rules to a `themes/` folder and also requires a stylesheet.

| | Plugin | Theme | Scraper |
|---|---|---|---|
| Folder | `plugins/` | `themes/` | `scrapers/` |
| Stash source type | plugin | plugin | scraper |
| Version | `version:` in the yml, with a matching `## x.y.z` in CHANGELOG.md | as plugin | first `## x.y.z` in CHANGELOG.md, because Stash rejects unknown scraper yml keys |
| Extra checks | `name`, `description`, `version` required; `ui` files exist; `.js` files pass `node --check` | as plugin, plus `ui.css` lists at least one file | `name` required; only keys Stash accepts |
| Index metadata | `description`, `url`, `commit` | as plugin | `commit` |

Shared behaviour lives in `lib/commands.mjs`; per-kind differences are in `lib/kinds.mjs`.

## Versions

Each package has its own version, and nobody writes it by hand:

- It is the package's last `<Id>/vX.Y.Z` tag, bumped by the merged PRs that touched its directory since: `!` or a `BREAKING CHANGE:` footer bumps major, `feat:` minor, `fix:`/`perf:` patch. PRs merged back to back release once, at the highest bump.
- Maintenance (`docs:`, `chore:`, `test:`, `ci:` ...) does not release. It ships in the zip, but the version and the index `date` stay at the last release, so Stash offers no update until the package's next fix or feature.
- The build writes the version into the shipped `<Id>.yml` (plugins and themes) and the index, and the deploy tags it.
- The shipped `CHANGELOG.md` gets a generated section for every version newer than its first `## x.y.z` heading. Each merged PR adds the lines of a `## Changelog` section in its body, or else its title. The hand-written history below stays as it is.
- A package with no tag yet releases at the version its yml or CHANGELOG.md recorded by hand, or at 0.1.0.

## Releasing a change to the tooling

Tag a new version (`v1.0.1`, `v1.1.0`, ...) and bump both the `devDependencies` ref and the workflow `@ref` in each package repo. The output of `build` should stay byte-identical unless the change is meant to alter it.
