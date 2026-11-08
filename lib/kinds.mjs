// What differs between a plugin source and a scraper source. Everything else
// (loading, zipping, dating, version checks, tagging) is shared.
//
// version(id, read): the package version, where read(name) returns the text
//   of a file in the package directory (from disk, or from a git revision) or null.
// validate(pkg, err): kind-specific checks; call err(message) per problem.
// metadata(pkg): extra index metadata, before the shared "commit" field.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import semver from "semver";
import YAML from "yaml";
import { changelogHasVersion, changelogVersion, isUrl, packageFiles } from "./core.mjs";

const plugin = {
  name: "plugin",
  dir: "plugins",
  version: (id, read) => {
    const raw = read(`${id}.yml`);
    if (raw == null) return null;
    try {
      return YAML.parse(raw)?.version ?? null;
    } catch {
      return null;
    }
  },
  bumpHint: (id) => `bump "version" in ${id}.yml and add a CHANGELOG.md entry`,
  validate(p, err) {
    const c = p.config;
    for (const field of ["name", "description", "version"]) {
      if (typeof c[field] !== "string" || !c[field].trim()) {
        err(`"${field}" is required`);
      }
    }
    const changelog = readIfExists(path.join(p.dir, "CHANGELOG.md"));
    if (typeof c.version === "string" && semver.valid(c.version) !== c.version) {
      err(`version "${c.version}" is not semver (e.g. 1.2.3, no leading v)`);
    } else if (typeof c.version === "string" && !changelogHasVersion(changelog, c.version)) {
      err(`CHANGELOG.md has no "## ${c.version}" entry`);
    }

    const ui = c.ui ?? {};
    for (const kind of ["javascript", "css"]) {
      for (const f of ui[kind] ?? []) {
        if (!isUrl(f) && !fs.existsSync(path.join(p.dir, f))) {
          err(`ui.${kind} file not found: ${f}`);
        }
      }
    }

    for (const f of packageFiles(p.dir)) {
      if (f.endsWith(".js")) {
        try {
          execFileSync(process.execPath, ["--check", path.join(p.dir, f)], {
            stdio: "pipe",
          });
        } catch (e) {
          err(`syntax error in ${f}\n${e.stderr}`);
        }
      }
    }
  },
  metadata(p) {
    const m = { description: p.config.description };
    if (p.config.url) m.url = p.config.url;
    return m;
  },
};

// top-level keys Stash accepts in a scraper yml; it rejects any others
const SCRAPER_KEYS = new Set([
  "name",
  "performerByName",
  "performerByFragment",
  "performerByURL",
  "sceneByName",
  "sceneByQueryFragment",
  "sceneByFragment",
  "sceneByURL",
  "galleryByFragment",
  "galleryByURL",
  "imageByFragment",
  "imageByURL",
  "groupByURL",
  "movieByURL",
  "xPathScrapers",
  "jsonScrapers",
  "stashServer",
  "debug",
  "driver",
]);

const scraper = {
  name: "scraper",
  dir: "scrapers",
  // Stash parses scraper yml strictly, so a scraper cannot carry a version
  // field. Its version is the first "## x.y.z" heading in its CHANGELOG.md.
  version: (id, read) => changelogVersion(read("CHANGELOG.md")),
  bumpHint: () => `add a new "## x.y.z" section at the top of its CHANGELOG.md`,
  validate(s, err) {
    const c = s.config;
    if (typeof c.name !== "string" || !c.name.trim()) err(`"name" is required`);
    for (const key of Object.keys(c)) {
      if (!SCRAPER_KEYS.has(key)) err(`unknown top-level key "${key}" (Stash would reject it)`);
    }
    if (s.version == null) {
      err(`CHANGELOG.md needs a "## x.y.z" heading for the current version`);
    } else if (semver.valid(s.version) !== s.version) {
      err(`version "${s.version}" in CHANGELOG.md is not semver (e.g. 1.2.3, no leading v)`);
    }
  },
  metadata: () => ({}),
};

export const KINDS = { plugin, scraper };

function readIfExists(f) {
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}
