import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import semver from "semver";
import YAML from "yaml";
import { ID_PATTERN, packageFiles } from "./core.mjs";
import { checkTitle, highestBump as highestBumpOf, stampVersion, withGenerated } from "./release.mjs";

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
  // is released: use the last commit that touched its directory. While a package
  // has no release pending, that is up to its last release tag, so maintenance
  // merged since does not make Stash offer an update.
  function lastChange(p) {
    const rel = path.relative(root, p.dir).replaceAll("\\", "/");
    const dirty = repo.tryGit("status", "--porcelain", "--", rel);
    const upTo = !p.release.release && p.release.tag ? [p.release.tag] : [];
    const committed = repo.tryGit("log", "-1", "--format=%ct %h", ...upTo, "--", rel);
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
    // the shipped yml and changelog carry the version CI worked out
    if (kind.stampsYml) {
      entries[`${p.id}.yml`] = [Buffer.from(stampVersion(p.raw, p.version)), { mtime: date }];
    }
    const changelogPath = path.join(p.dir, "CHANGELOG.md");
    const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : null;
    const generated = repo.releases.generatedChangelog(p, changelog);
    if (generated) {
      entries["CHANGELOG.md"] = [Buffer.from(withGenerated(changelog, generated)), { mtime: date }];
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

// Prints the version each package changed since <base> would release as, from
// its last tag and the commits since. With a title, counts it as one more merged
// commit (a PR's title, before it is merged). Never fails on versions: PRs do
// not carry them.
export function runPlan(repo, base, title) {
  const { kind, root } = repo;
  if (title != null && !checkTitle(title)) return runCheckTitle(title);
  let changed = null;
  if (base && !/^0+$/.test(base) && repo.tryGit("cat-file", "-e", `${base}^{commit}`) != null) {
    const rel = path.relative(root, repo.dir).replaceAll("\\", "/");
    changed = new Set(
      (repo.tryGit("diff", "--name-only", base, "HEAD", "--", rel) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((f) => f.split("/")[1])
    );
  }
  let any = false;
  for (const p of repo.loadAll()) {
    if (changed && !changed.has(p.id)) continue;
    const r = p.release;
    // A PR's own commits are not merged yet: count what the base has merged since
    // the package's last tag, plus the PR's title as the one commit it will add.
    const pending =
      title != null && changed
        ? [...(r.tag ? repo.releases.commits(p, [`${r.tag}..${base}`]) : []), { subject: title }]
        : r.commits;
    if (!pending.length && !r.release) continue;
    any = true;
    const bump = highestBumpOf(pending);
    if (!r.previous) console.log(`${p.id}: new at ${r.version}`);
    else if (!bump) console.log(`${p.id}: stays ${r.previous} (maintenance only; ships with its next fix or feature)`);
    else console.log(`${p.id}: ${r.previous} -> ${semver.inc(r.previous, bump)} (${bump})`);
  }
  if (!any) console.log(`no ${kind.name} changes`);
  return 0;
}

export function runCheckTitle(title) {
  if (checkTitle(title)) {
    console.log("title ok");
    return 0;
  }
  console.error(`error: use a Conventional Commit PR title, e.g. "fix(Insights): keep the calendar in local time" (got ${JSON.stringify(title)})`);
  return 1;
}

// Tags HEAD as <id>/v<version> for each package with a release since its last
// tag. Tags are created locally; the deploy workflow pushes them.
export function runTagReleases(repo) {
  for (const p of repo.loadAll()) {
    if (!p.release.release) continue;
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
