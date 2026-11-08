import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import semver from "semver";
import YAML from "yaml";
import { ID_PATTERN, packageFiles } from "./core.mjs";

// Checks every package is well-formed. Returns a list of error strings.
// A repo with no packages yet is valid and builds an empty index.
export function validate(repo, pkgs = repo.loadAll()) {
  const { kind } = repo;
  const errors = [];
  const ids = new Set(pkgs.map((p) => p.id));

  for (const p of pkgs) {
    const err = (msg) => errors.push(`${p.id}: ${msg}`);

    if (!ID_PATTERN.test(p.id)) {
      err(`directory name must match ${ID_PATTERN}`);
    }
    if (p.raw == null) {
      err(`missing ${p.id}.yml (the yml must be named after its directory)`);
      continue;
    }
    if (p.parseError) {
      err(`invalid yaml: ${p.parseError}`);
      continue;
    }

    kind.validate(p, err);

    for (const dep of p.requires) {
      if (!ids.has(dep)) err(`# requires: "${dep}" is not a ${kind.name} in this repo`);
    }
  }

  return errors;
}

export function runValidate(repo) {
  const { kind } = repo;
  const pkgs = repo.loadAll();
  const errors = validate(repo, pkgs);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    return 1;
  }
  console.log(pkgs.length ? `all ${kind.name}s valid` : `no ${kind.name}s under ${kind.dir}/ yet`);
  return 0;
}

// Builds the package source that Stash installs from:
//   <outdir>/index.yml       package index
//   <outdir>/<id>.zip        one zip per package, files at the zip root
// The deploy workflow pushes <outdir> to the dist branch, which Stash reads
// through raw.githubusercontent.com with an access token.
export function runBuild(repo, outArg = "_site") {
  const { kind, root } = repo;
  const outdir = path.resolve(root, outArg);

  const pkgs = repo.loadAll();
  const errors = validate(repo, pkgs);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    return 1;
  }

  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });

  // Stash flags an installed package as upgradable when the index date is
  // newer than the installed one, so the date must move whenever the package
  // changes: use the last commit that touched its directory.
  function lastChange(p) {
    const rel = path.relative(root, p.dir).replaceAll("\\", "/");
    const dirty = repo.tryGit("status", "--porcelain", "--", rel);
    const committed = repo.tryGit("log", "-1", "--format=%ct %h", "--", rel);
    if (dirty || !committed) {
      console.warn(`warning: ${p.id} has uncommitted changes, dating it now`);
      return { date: new Date(), commit: null };
    }
    const [ts, commit] = committed.split(" ");
    return { date: new Date(Number(ts) * 1000), commit };
  }

  const index = [];
  for (const p of pkgs) {
    const { date, commit } = lastChange(p);

    // fixed mtimes and sorted entries, so the zip (and its sha256) only
    // change when the package's contents do
    const entries = {};
    for (const f of packageFiles(p.dir)) {
      entries[f] = [fs.readFileSync(path.join(p.dir, f)), { mtime: date }];
    }
    const zip = zipSync(entries, { level: 9 });
    const zipName = `${p.id}.zip`;
    fs.writeFileSync(path.join(outdir, zipName), zip);

    const metadata = kind.metadata(p);
    if (commit) metadata.commit = commit;

    const entry = {
      id: p.id,
      name: p.config.name,
      version: p.version,
      date: stashTime(date),
      // relative, so Stash fetches it from the same host with the token
      path: zipName,
      sha256: crypto.createHash("sha256").update(zip).digest("hex"),
    };
    if (Object.keys(metadata).length) entry.metadata = metadata;
    if (p.requires.length) entry.requires = p.requires;
    index.push(entry);

    console.log(`${p.id} ${p.version} (${Object.keys(entries).length} files)`);
  }

  fs.writeFileSync(path.join(outdir, "index.yml"), YAML.stringify(index));
  console.log(
    `wrote ${index.length} ${kind.name}(s) to ${path.relative(root, outdir) || "."}`
  );
  return 0;
}

// Fails if a package's files changed since <base> without its version going up.
export function runCheckVersions(repo, base) {
  const { kind, root } = repo;
  if (!base || /^0+$/.test(base) || repo.tryGit("cat-file", "-e", `${base}^{commit}`) == null) {
    console.log(`no usable base ref (${base ?? "none"}), skipping version check`);
    return 0;
  }

  const rel = path.relative(root, repo.dir).replaceAll("\\", "/");
  const changed = new Set(
    (repo.tryGit("diff", "--name-only", base, "HEAD", "--", rel) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((f) => f.split("/")[1])
  );

  const errors = [];
  for (const id of [...changed].sort()) {
    if (!fs.existsSync(path.join(repo.dir, id))) {
      console.log(`${id}: removed`);
      continue;
    }
    const now = repo.load(id).version;
    const old = kind.version(id, (name) => repo.tryGit("show", `${base}:${rel}/${id}/${name}`));

    if (old == null) {
      console.log(`${id}: new ${kind.name} at ${now}`);
    } else if (!semver.valid(now) || !semver.valid(old) || !semver.gt(now, old)) {
      errors.push(
        `${id}: files changed but version went from ${old} to ${now} — ${kind.bumpHint(id)}`
      );
    } else {
      console.log(`${id}: ${old} -> ${now}`);
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    return 1;
  }
  if (changed.size === 0) console.log(`no ${kind.name} changes`);
  return 0;
}

// Tags HEAD as <id>/v<version> for each package version that has no tag yet.
// Tags are created locally; the deploy workflow pushes them.
export function runTagReleases(repo) {
  for (const p of repo.loadAll()) {
    const tag = `${p.id}/v${p.version}`;
    if (repo.tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) continue;
    repo.git("tag", tag);
    console.log(`tagged ${tag}`);
  }
  return 0;
}

// Stash's package time format: "2006-01-02 15:04:05", UTC
function stashTime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
