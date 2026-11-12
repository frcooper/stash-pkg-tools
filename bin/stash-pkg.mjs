#!/usr/bin/env node
// usage: stash-pkg <command> [args]
//   validate                 check every package is well-formed
//   build [outdir]           validate, then write index.yml and zips (default _site)
//   plan [base] [title]      print the version each changed package releases as
//   check-title <title>      fail unless the PR title is a Conventional Commit
//   tag-releases             tag HEAD as <id>/v<version> for each new release
//
// Versions are worked out from git: each package's last <id>/v* tag, bumped by
// the merged PRs (squash commits titled with the PR title) that touched it.
//
// Run from the root of a repo whose package.json sets
// "stashPackages": "plugin", "theme" or "scraper".
import { openRepo } from "../lib/core.mjs";
import {
  runBuild,
  runCheckTitle,
  runPlan,
  runTagReleases,
  runValidate,
} from "../lib/commands.mjs";

const COMMANDS = {
  validate: (repo) => runValidate(repo),
  build: (repo, args) => runBuild(repo, args[0]),
  plan: (repo, args) => runPlan(repo, args[0], args[1]),
  // kept for callers not yet moved to plan; versions are never checked any more
  "check-versions": (repo, args) => runPlan(repo, args[0]),
  "check-title": (repo, args) => runCheckTitle(args.join(" ")),
  "tag-releases": (repo) => runTagReleases(repo),
};

const [name, ...args] = process.argv.slice(2);
const command = COMMANDS[name];
if (!command) {
  console.error(`usage: stash-pkg <${Object.keys(COMMANDS).join("|")}> [args]`);
  process.exit(2);
}

let repo;
try {
  repo = openRepo();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}
process.exitCode = command(repo, args);
