/**
 * Parse combined unified diffs from runCommits (same shape as `saifctl run export`).
 */

export type DiffFileChange = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFileStat {
  /** Repo-relative path after change (or target path for renames). */
  path: string;
  /** Source path when {@link change} is `renamed`. */
  fromPath?: string;
  change: DiffFileChange;
  added: number;
  removed: number;
  /** Raw diff section (one `diff --git` block), for diff editor. */
  section: string;
}

/**
 * Count `+` / `-` body lines in one `diff --git` block for tree descriptions.
 * Skips headers (`diff --git`, `@@`, `---`/`+++`, mode lines, rename/binary markers).
 */
function countHunkLines(section: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of section.split('\n')) {
    // Skip metadata; only `+` / `-` / ` ` lines inside hunks contribute to counts.
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('Binary files ')
    ) {
      continue;
    }
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * Parse the first line of a section (`diff --git …`) into `a/` and `b/` paths (or `/dev/null` for adds).
 * Returns null if the line does not match Git’s usual unified-diff form.
 */
function parsePathsFromDiffGitLine(line: string): { aPath: string; bPath: string } | null {
  const fromNull = /^diff --git \/dev\/null b\/(.+)$/.exec(line);
  if (fromNull) {
    return { aPath: '/dev/null', bPath: fromNull[1]! };
  }
  const ab = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (ab) {
    return { aPath: ab[1]!, bPath: ab[2]! };
  }
  return null;
}

/** If the section is a Git rename, return old and new paths from `rename from` / `rename to`. */
function detectRename(section: string): { from: string; to: string } | null {
  const from = /^rename from (.+)$/m.exec(section);
  const to = /^rename to (.+)$/m.exec(section);
  if (from?.[1] && to?.[1]) {
    return { from: from[1].trim(), to: to[1].trim() };
  }
  return null;
}

/**
 * Decide add / delete / modify / rename and the canonical repo path for one section,
 * using `parsePathsFromDiffGitLine` output plus mode and rename lines inside the section.
 */
function classifySection(
  section: string,
  paths: { aPath: string; bPath: string },
): {
  change: DiffFileChange;
  path: string;
  fromPath?: string;
} {
  const rename = detectRename(section);
  if (rename) {
    return { change: 'renamed', path: rename.to, fromPath: rename.from };
  }
  if (section.includes('new file mode')) {
    return { change: 'added', path: paths.bPath };
  }
  if (section.includes('deleted file mode') || paths.bPath === '/dev/null') {
    return { change: 'deleted', path: paths.aPath };
  }
  return { change: 'modified', path: paths.bPath === '/dev/null' ? paths.aPath : paths.bPath };
}

/** Priority order for change types when merging across commits. */
const CHANGE_PRIORITY: Record<DiffFileChange, number> = {
  deleted: 4,
  added: 3,
  renamed: 2,
  modified: 1,
};

/**
 * Merge stats for the same file path that appear across multiple commits.
 * Sums line counts and keeps the highest-priority change type.
 */
function mergeStats(stats: DiffFileStat[]): DiffFileStat[] {
  const byPath = new Map<string, DiffFileStat>();
  for (const stat of stats) {
    const existing = byPath.get(stat.path);
    if (!existing) {
      byPath.set(stat.path, { ...stat });
    } else {
      existing.added += stat.added;
      existing.removed += stat.removed;
      if (CHANGE_PRIORITY[stat.change] > CHANGE_PRIORITY[existing.change]) {
        existing.change = stat.change;
        if (stat.fromPath) existing.fromPath = stat.fromPath;
      }
      existing.section += stat.section;
    }
  }
  return [...byPath.values()];
}

/**
 * Split a patch into per-file stats without merging duplicate paths
 * (one entry per `diff --git` block).
 */
export function parsePatchUnmerged(patch: string): DiffFileStat[] {
  const trimmed = patch.trim();
  if (!trimmed) return [];

  const sections = trimmed.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const out: DiffFileStat[] = [];

  for (const section of sections) {
    const firstLine = section.split('\n')[0] ?? '';
    const paths = parsePathsFromDiffGitLine(firstLine);
    if (!paths) continue;

    const { change, path, fromPath } = classifySection(section, paths);
    const { added, removed } = countHunkLines(section);
    out.push({
      path,
      fromPath,
      change,
      added,
      removed,
      section: section.endsWith('\n') ? section : `${section}\n`,
    });
  }

  return out;
}

/** First matching `diff --git` section for a repo-relative path (or rename source path). */
export function sectionForFilePath(stats: DiffFileStat[], filePath: string): string | undefined {
  const s = stats.find((x) => x.path === filePath || x.fromPath === filePath);
  return s?.section;
}

/**
 * Split a multi-file unified diff into per-file stats. Ignores empty input.
 * Files touched by multiple commits are merged into a single entry.
 */
export function parseCombinedPatch(patch: string): DiffFileStat[] {
  return mergeStats(parsePatchUnmerged(patch));
}

export interface DiffDirTrieNode {
  /** Segment name (not full path). */
  segment: string;
  /** Child directories. */
  dirs: DiffDirTrieNode[];
  /** Files in this directory. */
  files: DiffFileStat[];
}

function insertFile(root: DiffDirTrieNode, stat: DiffFileStat): void {
  const parts = stat.path.split('/').filter(Boolean);
  if (parts.length === 0) return;
  parts.pop();
  let node = root;
  for (const seg of parts) {
    let next = node.dirs.find((d) => d.segment === seg);
    if (!next) {
      next = { segment: seg, dirs: [], files: [] };
      node.dirs.push(next);
      node.dirs.sort((a, b) => a.segment.localeCompare(b.segment));
    }
    node = next;
  }
  node.files.push(stat);
  node.files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build a directory trie from flat file stats (for tree view).
 */
export function buildDiffDirTrie(stats: DiffFileStat[]): DiffDirTrieNode {
  const root: DiffDirTrieNode = { segment: '', dirs: [], files: [] };
  for (const s of stats) {
    insertFile(root, s);
  }
  root.dirs.sort((a, b) => a.segment.localeCompare(b.segment));
  return root;
}
