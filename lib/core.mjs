// Shared helpers for a Stash package source repo: one directory per package
// under the kind's folder (plugins/, themes/ or scrapers/), each holding <id>.yml.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { KINDS } from "./kinds.mjs";
import { openReleases } from "./release.mjs";

// Stash uses the package ID as the install directory (and, for plugins, the
// yml file name as the plugin ID), so keep IDs to characters safe in both.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export { KINDS };

// The consumer repo is wherever npm runs the script from: its package root.
// Its package.json names the kind: "stashPackages": "plugin" | "theme" | "scraper".
export function openRepo(root = process.cwd()) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const kindName = pkgJson.stashPackages;
  const kind = KINDS[kindName];
  if (!kind) {
    throw new Error(
      `package.json "stashPackages" must be one of ${Object.keys(KINDS).join(", ")} (got ${JSON.stringify(kindName)})`
    );
  }
  const dir = path.join(root, kind.dir);

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const tryGit = (...args) => {
    try {
      return git(...args);
    } catch {
      return null;
    }
  };

  function load(id) {
    const pkgDir = path.join(dir, id);
    const read = (name) => {
      const f = path.join(pkgDir, name);
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
    };
    const ymlPath = path.join(pkgDir, `${id}.yml`);
    const raw = read(`${id}.yml`);
    const parsed = parseConfig(raw);
    const p = {
      id,
      dir: pkgDir,
      ymlPath,
      raw,
      ...parsed,
      // the version recorded by hand before versions were worked out by CI
      legacyVersion: kind.version(id, read),
    };
    const n = releases.next(p);
    p.version = n.version;
    p.release = n;
    return p;
  }

  function loadAll() {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => load(d.name))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const repo = { root, kind, dir, git, tryGit, load, loadAll };
  const releases = openReleases(repo);
  repo.releases = releases;
  return repo;
}

export function parseConfig(raw) {
  if (raw == null) return { config: null, requires: [] };
  try {
    return { config: YAML.parse(raw) ?? {}, requires: parseRequires(raw) };
  } catch (e) {
    return { config: null, requires: [], parseError: e.message };
  }
}

// Package dependencies use the stashapp/Community* comment convention:
//   # requires: OtherPackage, AnotherPackage
export function parseRequires(raw) {
  const m = raw.match(/^#\s*requires:(.*)$/m);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The first "## x.y.z" heading in a changelog, or null.
export function changelogVersion(text) {
  if (text == null) return null;
  const m = text.match(/^##\s+\[?v?([^\s\]]+)\]?(\s|$)/m);
  return m ? m[1] : null;
}

export function changelogHasVersion(text, version) {
  if (text == null) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`, "m").test(text);
}

export function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

// Files shipped in a package's zip, as sorted posix paths relative to its
// directory. Dotfiles and Python caches are left out.
export function packageFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "__pycache__") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}
