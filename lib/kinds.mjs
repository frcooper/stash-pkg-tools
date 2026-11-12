// What differs between a plugin, theme and scraper source. Everything else
// (loading, zipping, dating, version checks, tagging) is shared.
//
// version(id, read): the package version, where read(name) returns the text
//   of a file in the package directory (from disk, or from a git revision) or null.
// validate(pkg, err): kind-specific checks; call err(message) per problem.
// metadata(pkg): extra index metadata, before the shared "commit" field.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { changelogVersion, isUrl, packageFiles } from "./core.mjs";

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
  // the build writes the version CI works out into the yml it ships
  stampsYml: true,
  validate(p, err) {
    const c = p.config;
    for (const field of ["name", "description"]) {
      if (typeof c[field] !== "string" || !c[field].trim()) {
        err(`"${field}" is required`);
      }
    }
    if (c.version !== undefined) {
      err(`remove "version" from ${p.id}.yml: CI works it out from the ${p.id}/v* tags and merged PR titles`);
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
  // field: its version is only in the index and its generated CHANGELOG.md.
  // Before CI worked versions out, it was the first "## x.y.z" heading there.
  version: (id, read) => changelogVersion(read("CHANGELOG.md")),
  stampsYml: false,
  validate(s, err) {
    const c = s.config;
    if (typeof c.name !== "string" || !c.name.trim()) err(`"name" is required`);
    for (const key of Object.keys(c)) {
      if (!SCRAPER_KEYS.has(key)) err(`unknown top-level key "${key}" (Stash would reject it)`);
    }
  },
  metadata: () => ({}),
};

// Stash has no theme package type: a theme is a plugin whose ui.css restyles
// the UI, installed from a plugin source. It gets the plugin rules, its own
// folder, and must ship at least one stylesheet.
const theme = {
  ...plugin,
  name: "theme",
  dir: "themes",
  validate(p, err) {
    plugin.validate(p, err);
    if (!(p.config.ui?.css ?? []).length) err(`"ui.css" must list at least one stylesheet`);
  },
};

export const KINDS = { plugin, theme, scraper };
