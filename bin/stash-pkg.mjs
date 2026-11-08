#!/usr/bin/env node
// usage: stash-pkg <command> [args]
//   validate                 check every package is well-formed
//   build [outdir]           validate, then write index.yml and zips (default _site)
//   check-versions <base>    fail if a changed package's version did not go up
//   tag-releases             tag HEAD as <id>/v<version> for untagged versions
//
// Run from the root of a repo whose package.json sets
// "stashPackages": "plugin", "theme" or "scraper".
import { openRepo } from "../lib/core.mjs";
import {
  runBuild,
  runCheckVersions,
  runTagReleases,
  runValidate,
} from "../lib/commands.mjs";

const COMMANDS = {
  validate: (repo) => runValidate(repo),
  build: (repo, args) => runBuild(repo, args[0]),
  "check-versions": (repo, args) => runCheckVersions(repo, args[0]),
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
