// Package versions are worked out from git, never written by hand. Each package
// keeps its own version: its last <id>/vX.Y.Z tag, bumped by the merged PRs that
// touched its directory since (first-parent squash commits, titled with the PR's
// Conventional Commit title). A breaking change bumps major, feat minor, fix/perf
// patch. Maintenance (docs:, chore:, ci:, test: ...) does not release: it ships in
// the zip, but the version and the index date stay at the last release, so Stash
// offers no update until the package's next fix or feature.
//
// The changelog for those versions is generated too. A PR body may carry a
// "## Changelog" section; its lines become the entry, otherwise the PR title does.
// CHANGELOG.md keeps the hand-written history; the build prepends the generated
// sections for every version newer than its first "## x.y.z" heading.
import path from "node:path";
import semver from "semver";
import { changelogVersion } from "./core.mjs";

export const INITIAL_VERSION = "0.1.0";
const BUMPS = ["patch", "minor", "major"];
const TITLE_RE =
  /^(feat|fix|perf|docs|chore|ci|test|refactor|build|style|revert)(?:\([A-Za-z0-9][A-Za-z0-9._/-]*\))?(!)?: \S[^\r\n]*$/;
const SUBJECT_RE = /^([a-z]+)(?:\(([^)\r\n]+)\))?(!)?: (\S.*)$/;

export function checkTitle(title) {
  return TITLE_RE.test(title ?? "");
}

// The bump one merged commit asks for, or null for maintenance.
export function bumpFor({ subject, body = "" }) {
  const m = SUBJECT_RE.exec(subject);
  if (!m) return null;
  if (m[3] || /^BREAKING[ -]CHANGE:/m.test(body)) return "major";
  if (m[1] === "feat") return "minor";
  return ["fix", "perf"].includes(m[1]) ? "patch" : null;
}

export function highestBump(commits) {
  let best = null;
  for (const c of commits) {
    const b = bumpFor(c);
    if (b && (!best || BUMPS.indexOf(b) > BUMPS.indexOf(best))) best = b;
  }
  return best;
}

// Lines for one commit's changelog entry: the PR body's "## Changelog" section,
// or the PR title's description.
export function entryLines({ subject, body = "" }) {
  const lines = body.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^##\s+changelog\s*$/i.test(l.trim()));
  if (start >= 0) {
    const out = [];
    for (const l of lines.slice(start + 1)) {
      if (/^#{1,2}\s/.test(l)) break;
      out.push(l);
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) return out;
  }
  const m = SUBJECT_RE.exec(subject);
  const text = (m ? m[4] : subject).replace(/\s*\(#\d+\)$/, "");
  return [`- ${text.charAt(0).toUpperCase()}${text.slice(1)}`];
}

export function openReleases(repo) {
  const rel = (p) => path.relative(repo.root, p.dir).replaceAll("\\", "/");

  function tags(p) {
    const out = repo.tryGit("tag", "--merged", "HEAD", "--list", `${p.id}/v*`) ?? "";
    return out
      .split("\n")
      .filter(Boolean)
      .map((t) => ({ tag: t, version: t.slice(p.id.length + 2) }))
      .filter((t) => semver.valid(t.version) === t.version)
      .sort((a, b) => semver.compare(a.version, b.version));
  }

  function commits(p, range) {
    const raw =
      repo.tryGit("log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", ...range, "--", rel(p)) ?? "";
    return raw
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, subject, body = ""] = r.split("\x1f");
        return { hash, subject, body };
      });
  }

  // { version, previous, release, bump, commits, tag } for HEAD. commits: those
  // since the last tag that touched the package. A package with no tag yet starts
  // from the version its CHANGELOG.md or yml last recorded by hand, else from
  // INITIAL_VERSION.
  function next(p) {
    const t = tags(p);
    const last = t.length ? t[t.length - 1] : null;
    if (last) {
      const since = commits(p, [`${last.tag}..HEAD`]);
      const bump = highestBump(since);
      if (!bump) return { version: last.version, previous: last.version, release: false, bump: null, commits: since, tag: last.tag };
      return { version: semver.inc(last.version, bump), previous: last.version, release: true, bump, commits: since, tag: last.tag };
    }
    const recorded = p.legacyVersion;
    if (recorded && semver.valid(recorded) === recorded) {
      return { version: recorded, previous: null, release: true, bump: null, commits: [] };
    }
    return { version: INITIAL_VERSION, previous: null, release: true, bump: null, commits: commits(p, ["HEAD"]) };
  }

  // Changelog sections for every released or pending version newer than the
  // first "## x.y.z" heading in CHANGELOG.md, newest first, as markdown.
  function generatedChangelog(p, changelog) {
    const written = changelogVersion(changelog);
    const floor = written && semver.valid(written) === written ? written : null;
    const sections = [];
    const t = tags(p);
    for (let i = 0; i < t.length; i++) {
      if (floor && !semver.gt(t[i].version, floor)) continue;
      const range = i > 0 ? [`${t[i - 1].tag}..${t[i].tag}`] : [t[i].tag];
      sections.push({ version: t[i].version, commits: commits(p, range) });
    }
    const n = next(p);
    if (n.release && n.commits.length && (!floor || semver.gt(n.version, floor))) {
      sections.push({ version: n.version, commits: n.commits });
    }
    return sections
      .reverse()
      .map((s) => {
        // maintenance merged in between ships with the release, but isn't listed
        // oldest first within a version
        const shipped = s.commits.filter((c) => bumpFor(c)).reverse();
        const lines = (shipped.length ? shipped : [...s.commits].reverse()).flatMap(entryLines);
        return `## ${s.version}\n\n${(lines.length ? lines : ["- Maintenance."]).join("\n")}\n`;
      })
      .join("\n");
  }

  return { tags, commits, next, generatedChangelog };
}

// CHANGELOG.md with the generated sections inserted after its "# ..." title.
export function withGenerated(changelog, generated) {
  if (!generated) return changelog;
  const text = changelog ?? "# Changelog\n";
  const m = text.match(/^# [^\n]*\n+/);
  const head = m ? m[0] : "# Changelog\n\n";
  const rest = m ? text.slice(m[0].length) : text;
  return `${head}${generated}${rest ? `\n${rest}` : ""}`;
}

// A plugin or theme yml with its top-level "version:" set: replaced in place, or
// inserted after the description (or name) and its continuation lines.
export function stampVersion(raw, version) {
  const line = `version: ${version}`;
  if (/^version:.*$/m.test(raw)) return raw.replace(/^version:.*$/m, line);
  const lines = raw.split("\n");
  let at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) at = lines.findIndex((l) => /^name:/.test(l));
  if (at < 0) return `${line}\n${raw}`;
  let end = at + 1;
  while (end < lines.length && /^[ \t]/.test(lines[end])) end++;
  lines.splice(end, 0, line);
  return lines.join("\n");
}
