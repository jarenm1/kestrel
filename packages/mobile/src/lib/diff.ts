/** Parses `git diff` unified output (fixed `a/` `b/` prefixes, as the box produces it) into per-file sections. */

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  /** The line is the last in its file and has no trailing newline. */
  noNewline: boolean;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` range as git printed it. */
  readonly range: string;
  /** Text after the closing `@@` (usually the enclosing function). */
  readonly section: string;
  readonly lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: DiffFileStatus;
  binary: boolean;
  /** Old and new mode when only the mode changed or it changed alongside content. */
  modeChange: { readonly from: string; readonly to: string } | null;
  readonly hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Path shown for a file: the new path, except for deletions. */
export const displayPath = (file: DiffFile): string => (file.status === "deleted" ? file.oldPath : file.newPath);

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undoes git's C-style path quoting (`"a/caf\303\251"`); octal escapes are UTF-8 bytes. */
function unquote(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 1; i < quoted.length - 1; i++) {
    const ch = quoted.charAt(i);
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = quoted.charAt(i + 1);
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(quoted.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A path from a `---`/`+++`/`rename` line: unquoted, with a/ or b/ stripped; `null` for /dev/null. */
function headerPath(raw: string, prefix: "a/" | "b/" | ""): string | null {
  // Git appends a tab after names that contain a space.
  const value = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (value === "/dev/null") return null;
  const path = value.startsWith('"') ? unquote(value) : value;
  return prefix !== "" && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Splits the paths out of `diff --git a/X b/Y`. Unquoted names with spaces are only unambiguous when X equals Y. */
function gitHeaderPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    const close = end === -1 ? rest.length - 1 : end;
    const oldPath = headerPath(rest.slice(0, close + 1), "a/") ?? "";
    const newPath = headerPath(rest.slice(close + 2), "b/") ?? "";
    return { oldPath, newPath };
  }
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0 && rest.slice(2, 2 + half) === rest.slice(rest.length - half)) {
    const path = rest.slice(2, 2 + half);
    return { oldPath: path, newPath: path };
  }
  const split = rest.indexOf(" b/");
  if (split === -1) return { oldPath: rest, newPath: rest };
  return { oldPath: headerPath(rest.slice(0, split), "a/") ?? "", newPath: headerPath(rest.slice(split + 1), "b/") ?? "" };
}

const HUNK_HEADER = /^(@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@) ?(.*)$/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  // Lines still expected in the current hunk; header lines are only recognised once both reach zero,
  // so content such as a removed "-- x" line (shown as "--- x") is never mistaken for a file header.
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;
  let oldMode = "";

  for (const line of text.split("\n")) {
    if (hunk !== null && file !== null && (oldLeft > 0 || newLeft > 0)) {
      const marker = line.charAt(0);
      const body = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: body, oldLine: null, newLine: newLine++, noNewline: false });
        newLeft--;
        file.additions++;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ kind: "del", text: body, oldLine: oldLine++, newLine: null, noNewline: false });
        oldLeft--;
        file.deletions++;
        continue;
      }
      if (marker === " " || line === "") {
        hunk.lines.push({ kind: "context", text: body, oldLine: oldLine++, newLine: newLine++, noNewline: false });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith("\\")) {
      const last = hunk?.lines.at(-1);
      if (last) last.noNewline = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const paths = gitHeaderPaths(line.slice("diff --git ".length));
      file = { ...paths, status: "modified", binary: false, modeChange: null, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      oldLeft = 0;
      newLeft = 0;
      oldMode = "";
      continue;
    }
    if (file === null) continue;

    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      oldLine = Number(match[2]);
      newLine = Number(match[4]);
      oldLeft = match[3] === undefined ? 1 : Number(match[3]);
      newLeft = match[5] === undefined ? 1 : Number(match[5]);
      hunk = { range: match[1] ?? "", section: match[6] ?? "", lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = headerPath(line.slice(4), "a/");
      if (path === null) file.status = "added";
      else file.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4), "b/");
      if (path === null) file.status = "deleted";
      else file.newPath = path;
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      file.oldPath = headerPath(line.slice("rename from ".length), "") ?? file.oldPath;
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.newPath = headerPath(line.slice("rename to ".length), "") ?? file.newPath;
      file.status = "renamed";
    } else if (line.startsWith("old mode ")) {
      oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      file.modeChange = { from: oldMode, to: line.slice("new mode ".length) };
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  return files;
}
