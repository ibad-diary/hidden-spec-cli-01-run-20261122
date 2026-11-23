// mend: one patch tool for every AI edit format.
//
// Applies an AI-written edit to a tree of text files, as SPEC.md (version 1)
// in the kit's starter specifies: unified diffs (often with wrong line
// numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool
// calls. Lines are matched at the first of three tiers (exact, trailing
// whitespace ignored, surrounding whitespace ignored). Every file is changed
// or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break, and whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  finalBr: boolean;
}
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}
function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Format detection (SPEC.md section 4). */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

function normLine(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Every 0-based position at or after `from` where O occurs at this tier. */
function occurrencesAt(lines: string[], o: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0): { tier: Tier; positions: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * Map N's lines onto the file at the matched position. Context lines come
 * from the file; at tier 2 every other non-empty, non-whitespace line that
 * starts with O's first line's leading whitespace has that whitespace
 * replaced by the file's first matched line's. With an empty O there is no
 * first line to re-indent from, so N is written as it is.
 */
function mapNewLines(fileLines: string[], pos: number, n: NewLine[], tier: Tier, oFirst: string | null): string[] {
  if (oFirst === null) return n.map((e) => e.text);
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oFirst);
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

/** Replace O's lines at `pos` by N, and report the lines written. */
function spliceReplacement(model: FileModel, pos: number, oLen: number, n: NewLine[], tier: Tier, oFirst: string | null): string[] {
  const written = mapNewLines(model.lines, pos, n, tier, oFirst);
  model.lines.splice(pos, oLen, ...written);
  return written;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const model = splitFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface HunkBodyEntry {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkBodyEntry[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
}

interface UnifiedSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: text after four characters, up to the first tab, trimmed. */
function diffPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** Strip one leading `a/` or `b/` from a diff path; `/dev/null` becomes null. */
function cleanDiffPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: HunkBodyEntry[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j += 1;
    } else if (l[0] === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
    } else if (l[0] === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j += 1;
    } else if (l[0] === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j += 1;
    } else if (l[0] === '\\') {
      body.push({ kind: 'mark', text: l.slice(1) });
      j += 1;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  let noNewline = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const e = body[k]!;
    if (e.kind === 'ctx' || e.kind === 'new') {
      noNewline = k + 1 < body.length && body[k + 1]!.kind === 'mark';
      break;
    }
  }
  return { hunk: { a: parseInt(m[1]!, 10), body, noNewline }, next: j };
}

/**
 * Parse a section's header (before its first hunk) and its hunks.
 * `i` is the index just after the line that started the section.
 */
function parseUnifiedSection(lines: string[], i: number, sec: UnifiedSection): number {
  let pairSeen = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldPath = cleanDiffPath(diffPath(l));
        sec.newPath = cleanDiffPath(diffPath(lines[i + 1]!));
        pairSeen = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l === 'new file mode' || l.startsWith('new file mode ')) {
      sec.newFile = true;
      i += 1;
      continue;
    }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
      sec.deletedFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!pairSeen) sec.oldPath = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!pairSeen) sec.newPath = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    // index, old mode, new mode, similarity index, dissimilarity index,
    // Index: and any other line are ignored.
    i += 1;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UnifiedSection = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      i = parseUnifiedSection(lines, i + 1, sec);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UnifiedSection = {
        oldPath: cleanDiffPath(diffPath(l)),
        newPath: cleanDiffPath(diffPath(lines[i + 1]!)),
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i = parseUnifiedSection(lines, i + 2, sec);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** Split a hunk body into its old lines O and new lines N (with context mapping). */
function hunkSides(hunk: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const e of hunk.body) {
    if (e.kind === 'ctx') {
      n.push({ text: e.text, ctx: true, oIdx: o.length });
      o.push(e.text);
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ text: e.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkSides(hunk);
    if (o.length > 0) {
      const match = findMatch(model.lines, o, strict);
      if (match === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = match.positions[0]!;
      for (const p of match.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const touchesEnd = pos + o.length === model.lines.length;
      const written = spliceReplacement(model, pos, o.length, n, match.tier, o[0]!);
      if (touchesEnd) model.finalBr = !hunk.noNewline;
      d += written.length - o.length;
    } else {
      const insertPos = Math.max(0, Math.min(hunk.a + d, model.lines.length));
      const touchesEnd = insertPos === model.lines.length;
      const written = n.map((e) => e.text);
      model.lines.splice(insertPos, 0, ...written);
      if (touchesEnd) model.finalBr = !hunk.noNewline;
      d += written.length;
    }
  }
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    if (isCreate) {
      if (newP === null) return; // both paths /dev/null: nothing to create
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const hunk of sec.hunks) {
        for (const e of hunk.body) {
          if (e.kind === 'new') plus.push(e.text);
        }
      }
      // A `\` line counts only when it follows the section's last `+` line.
      let lastPlus: { hunk: Hunk; k: number } | null = null;
      sec.hunks.forEach((hunk) => {
        hunk.body.forEach((e, k) => {
          if (e.kind === 'new') lastPlus = { hunk, k };
        });
      });
      const finalBr = lastPlus === null ? plus.length > 0 : !(lastPlus.k + 1 < lastPlus.hunk.body.length && lastPlus.hunk.body[lastPlus.k + 1]!.kind === 'mark');
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return; // both paths /dev/null: nothing to delete
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const model = splitFile(before);
      applyHunks(model, sec.hunks, strict, oldP!);
      const out = joinFile(model);
      tree.now.set(newP!, out);
      tree.now.set(oldP!, null);
      recordMove(oldP!, newP!);
      return;
    }
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    const model = splitFile(before);
    applyHunks(model, sec.hunks, strict, oldP!);
    tree.now.set(oldP!, joinFile(model));
  };
}

// Moves this run performed, for the `R <old> -> <new>` output lines.
const moves: { old: string; nw: string }[] = [];
function recordMove(oldP: string, newP: string): void {
  moves.push({ old: oldP, nw: newP });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SearchReplaceBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = splitFile(before);
    const match = findMatch(model.lines, b.oldLines, strict);
    if (match === null) throw new Fail('no-match', p);
    if (match.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = match.positions[0]!;
    const n: NewLine[] = b.newLines.map((text) => ({ text, ctx: false, oIdx: -1 }));
    spliceReplacement(model, pos, b.oldLines.length, n, match.tier, b.oldLines[0]!);
    tree.now.set(p, joinFile(model));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkBodyEntry[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  line: number; // 1-based line of the section header (for the no-chunk error)
}

const V4A_MARKERS = [
  { prefix: '*** Add File:', kind: 'add' as const },
  { prefix: '*** Delete File:', kind: 'delete' as const },
  { prefix: '*** Update File:', kind: 'update' as const },
];

function v4aSectionStart(trimmed: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const m of V4A_MARKERS) {
    if (trimmed.startsWith(m.prefix)) return { kind: m.kind, path: trimmed.slice(m.prefix.length).trim() };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const start = v4aSectionStart(l.trim());
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: V4aSection = { kind: start.kind, path: start.path, moveTo: null, addLines: [], chunks: [], line: i + 1 };
    i += 1;
    i = parseV4aSection(lines, i, last, sec);
    sections.push(sec);
  }
  return sections.map((sec) => v4aSectionEdit(sec, strict));
}

/** Parse one V4A section's body; returns the index of the next section start or `last`. */
function parseV4aSection(lines: string[], i: number, last: number, sec: V4aSection): number {
  let current: V4aChunk | null = null;
  const closeChunk = (): void => {
    current = null;
  };
  while (i < last) {
    const l = lines[i]!;
    const t = l.trim();
    if (v4aSectionStart(t) !== null) break;
    if (blank(l)) {
      if (sec.kind === 'update' && current !== null) {
        current.body.push({ kind: 'ctx', text: '' });
      } else if (sec.kind === 'add') {
        sec.addLines.push('');
      }
      // In a Delete section, and between chunks, blank lines are ignored.
      i += 1;
      continue;
    }
    if (t.startsWith('***')) {
      if (sec.kind === 'update' && t.startsWith('*** Move to:') && sec.moveTo === null && sec.chunks.length === 0 && current === null) {
        sec.moveTo = t.slice('*** Move to:'.length).trim();
        i += 1;
        continue;
      }
      if (sec.kind === 'update' && t === '*** End of File') {
        if (current === null) throw new Exit2(`error: parse ${i + 1}`);
        current.eof = true;
        closeChunk();
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'add') {
      if (l.startsWith('+')) sec.addLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (sec.kind === 'delete') throw new Exit2(`error: parse ${i + 1}`);
    // Update section.
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      current = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      sec.chunks.push(current);
      i += 1;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (current === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        current = { anchor: null, eof: false, body: [] };
        sec.chunks.push(current);
      }
      if (l === '') current.body.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') current.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') current.body.push({ kind: 'old', text: l.slice(1) });
      else current.body.push({ kind: 'new', text: l.slice(1) });
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sec.kind === 'update') {
    // Blank lines at the end of a section are not part of it.
    if (current !== null) {
      while (current.body.length > 0) {
        const e = current.body[current.body.length - 1]!;
        if (e.kind === 'ctx' && e.text === '') current.body.pop();
        else break;
      }
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  }
  if (sec.kind === 'add') {
    while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
  }
  return i;
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const model = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const anchorMatch = findMatch(model.lines, [chunk.anchor], strict, cursor);
        if (anchorMatch === null) throw new Fail('no-match', p);
        cursor = anchorMatch.positions[0]! + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const e of chunk.body) {
        if (e.kind === 'ctx') {
          n.push({ text: e.text, ctx: true, oIdx: o.length });
          o.push(e.text);
        } else if (e.kind === 'old') {
          o.push(e.text);
        } else if (e.kind === 'new') {
          n.push({ text: e.text, ctx: false, oIdx: -1 });
        }
      }
      if (o.length > 0) {
        const match = findMatch(model.lines, o, strict, cursor);
        if (match === null) throw new Fail('no-match', p);
        const pos = match.positions[0]!;
        if (chunk.eof && pos + o.length !== model.lines.length) throw new Fail('no-match', p);
        const written = spliceReplacement(model, pos, o.length, n, match.tier, o[0]!);
        cursor = pos + written.length;
      } else {
        const insertPos = chunk.eof ? model.lines.length : cursor;
        const written = n.map((e) => e.text);
        model.lines.splice(insertPos, 0, ...written);
        cursor = insertPos + written.length;
      }
    }
    const out = joinFile(model);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(p, null);
      recordMove(p, sec.moveTo);
    } else {
      tree.now.set(p, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Running the CLI.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.now.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && tree.now.has(m.old) && tree.now.has(m.nw)) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      moved.add(m.old);
      moved.add(m.nw);
    }
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
