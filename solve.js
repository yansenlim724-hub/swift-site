// Fast drop-in for makefun-site 1.0.0.
//
// Same answers, byte for byte, on every input — same front matter rules, same
// template dialect, same Markdown subset, same slug rule, same report. The
// speed comes from doing the same work with less machinery:
//
//   - Markdown is rendered in one fused pass: block classification by direct
//     character tests instead of a regex per line, and inline rendering that
//     scans for the next meaningful character instead of escaping every
//     character one at a time.
//   - Templates are rendered into an array that is joined once, with scope
//     objects reused across loop iterations instead of rebuilt per item.
//   - Slugs are memoised within a single build (never across cases), with a
//     fast path for plain ASCII text that skips Unicode normalisation.
//   - Front matter is parsed by scanning the raw text, so the body never
//     gets split into lines and joined back together.
//
// Nothing is cached from one case to the next: every per-build table (slug
// memo, link memo, parsed templates) is created fresh inside run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (text.indexOf('&') === -1 && text.indexOf('<') === -1 && text.indexOf('>') === -1 && text.indexOf('"') === -1 && text.indexOf("'") === -1) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ent = null;
    if (c === 38) ent = '&amp;';
    else if (c === 60) ent = '&lt;';
    else if (c === 62) ent = '&gt;';
    else if (c === 34) ent = '&quot;';
    else if (c === 39) ent = '&#39;';
    if (ent !== null) {
      if (i > start) out += text.slice(start, i);
      out += ent;
      start = i + 1;
    }
  }
  if (start === 0) return text;
  if (start < text.length) out += text.slice(start);
  return out;
}

/** The slice `s[lo:hi]` escaped, pushed to `out`. */
function escapeRange(s, lo, hi, out) {
  let start = lo;
  for (let i = lo; i < hi; i++) {
    const c = s.charCodeAt(i);
    let ent = null;
    if (c === 38) ent = '&amp;';
    else if (c === 60) ent = '&lt;';
    else if (c === 62) ent = '&gt;';
    else if (c === 34) ent = '&quot;';
    else if (c === 39) ent = '&#39;';
    if (ent !== null) {
      if (i > start) out.push(s.slice(start, i));
      out.push(ent);
      start = i + 1;
    }
  }
  if (start < hi) out.push(s.slice(start, hi));
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  // "2026-11-09" -> "9 November 2026". The string is already validated, so
  // the slices are fixed positions.
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48); // month 1-12
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whitespace in the /\s/ sense (no /u flag: the ASCII set plus the usual Unicode spaces). */
function isSpace(code) {
  return (
    code === 32 || (code >= 9 && code <= 13) ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff
  );
}

// ---------------------------------------------------------------- slugs

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left.
 *
 * `memo` is the current build's memo table. The fast path handles pure ASCII
 * text, where NFKD is the identity and there are no combining marks, so the
 * normalisation and the mark regex are skipped entirely.
 */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  const parts = [];
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain.charCodeAt(i);
    let keep = -1;
    if (ch >= 65 && ch <= 90) keep = ch + 32;
    else if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)) keep = ch;
    if (keep === -1) {
      gap = parts.length > 0;
      continue;
    }
    if (gap) parts.push('-');
    gap = false;
    parts.push(String.fromCharCode(keep));
  }
  out = parts.join('').slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). `next` remembers, per base slug, where the last collision search ended, so a repeated base never rescans suffixes that are already known taken. */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = next.get(slug) || 2;
  let out = `${slug}-${n}`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  taken.add(out);
  next.set(slug, n + 1);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c >= 128 && isSpace(c))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) {
          y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
          mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
          d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
          if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
        }
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z and _
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The body is sliced
 * out of the text, never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  if (text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  // Find the closing line: a line that is exactly '---'. The search starts
  // at the '\n' ending the opening line, so a closing line at once (an
  // empty front matter) is found too.
  let closeStart = -1; // index of the '\n' just before the closing '---'
  let closeEnd = -1; // index just past the closing '---' line (and its '\n', if any)
  let search = 3;
  while (true) {
    const nl = text.indexOf('\n---', search);
    if (nl === -1) {
      if (text.endsWith('\n---')) { closeStart = text.length - 4; closeEnd = text.length; }
      break;
    }
    const after = nl + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = nl;
      closeEnd = after === text.length ? text.length : after + 1;
      break;
    }
    search = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2; // the first line between the markers is line 2
  let pos = 4;
  while (pos < closeStart) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1 || eol > closeStart) eol = closeStart;
    const line = text.slice(pos, eol);
    // Blank (spaces and tabs only) or a comment ('#' first).
    let p = 0;
    while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
    if (p === line.length || line.charCodeAt(0) === 35) {
      pos = eol + 1;
      lineNo++;
      continue;
    }
    // "key: value": a key of a-z and '_', a colon, one space and the value.
    let k = 0;
    while (k < line.length && isKeyChar(line.charCodeAt(k))) k++;
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let rEnd = raw.length;
    while (rEnd > 0 && (raw.charCodeAt(rEnd - 1) === 32 || raw.charCodeAt(rEnd - 1) === 9)) rEnd--;
    if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = eol + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapable(code) {
  return code < 128 && ESCAPABLE[code] === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. `what` is ']' or '**'. */
function findUnescaped(s, what, from, hi) {
  if (what === ']') {
    for (let j = from; j < hi; j++) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
      if (c === 93) return j;
    }
    return -1;
  }
  for (let j = from; j + 1 < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** The characters that can start an inline construct or need escaping. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * `s[lo:hi]` rendered inline, appended to `out`. `link(target)` resolves a
 * link's href. A native regex scan jumps straight to the next interesting
 * character, so plain text is pushed whole with no per-character loop and
 * no second escaping pass; strong, emphasis and link bodies are rendered
 * into the same array over their ranges, with no intermediate strings.
 * The regex is shared: the loop keeps its position in a local, and sets
 * lastIndex before every search, so nested calls cannot disturb it.
 */
function inlineTo(s, link, out, lo, hi) {
  const re = INLINE_RE;
  let i = lo;
  while (true) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null || m.index >= hi) break;
    const p = m.index;
    if (p > i) out.push(s.slice(i, p));
    const c = s.charCodeAt(p);
    if (c === 92) { // backslash
      if (p + 1 < hi && isEscapable(s.charCodeAt(p + 1))) {
        // The escaped character is written escaped: '>' is both escapable
        // and an HTML special, so it becomes '&gt;'.
        out.push(s[p + 1] === '>' ? '&gt;' : s[p + 1]);
        i = p + 2;
        continue;
      }
      out.push('\\');
      i = p + 1;
      continue;
    }
    if (c === 96) { // backtick: a code span
      const j = s.indexOf('`', p + 1);
      if (j > p + 1 && j < hi) {
        out.push('<code>');
        escapeRange(s, p + 1, j, out);
        out.push('</code>');
        i = j + 1;
        continue;
      }
      out.push('`');
      i = p + 1;
      continue;
    }
    if (c === 42) { // asterisk: strong or emphasis
      if (s.charCodeAt(p + 1) === 42) {
        const j = findUnescaped(s, '**', p + 2, hi);
        if (j > p + 2) {
          out.push('<strong>');
          inlineTo(s, link, out, p + 2, j);
          out.push('</strong>');
          i = j + 2;
          continue;
        }
        out.push('**');
        i = p + 2;
        continue;
      }
      const j = findSingleStar(s, p + 1, hi);
      if (j > p + 1) {
        out.push('<em>');
        inlineTo(s, link, out, p + 1, j);
        out.push('</em>');
        i = j + 1;
        continue;
      }
      out.push('*');
      i = p + 1;
      continue;
    }
    if (c === 91) { // '[': a link
      const k = findUnescaped(s, ']', p + 1, hi);
      const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= hi ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineTo(s, link, out, p + 1, k);
        out.push('</a>');
        i = m2 + 1;
        continue;
      }
      out.push('[');
      i = p + 1;
      continue;
    }
    // & < > " ' : the entity, and the run before it was already pushed.
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    i = p + 1;
  }
  if (hi > i) out.push(s.slice(i, hi));
}

/** `s` rendered inline, as a string. */
function inline(s, link) {
  const out = [];
  inlineTo(s, link, out, 0, s.length);
  return out.join('');
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHR(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let j = 3; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/**
 * A list item's start on `line`, or null: { ordered, start, rest }.
 * A bullet is `- ` or `* `; an ordered item is 1-9 digits and `. `.
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, rest: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let j = 1;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, j)), rest: line.slice(j + 2) };
    }
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isSpace(line.charCodeAt(j));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). `link` resolves link targets;
 * `slugMemo` is the build's slug memo, `ids` is fresh per page.
 */
function renderMarkdown(src, link, slugMemo) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = null;
  let i = 0;
  // One list block, starting at the current line (which listStart accepts).
  const listBlock = () => {
    const first = listStart(lines[i]);
    const items = [];
    while (i < n) {
      const m2 = listStart(lines[i]);
      if (m2 !== null && m2.ordered === first.ordered) {
        items.push([trimLine(m2.rest)]);
        i++;
      } else if (isContinued(lines[i])) {
        items[items.length - 1].push(trimLine(lines[i]));
        i++;
      } else break;
    }
    const tag = first.ordered ? 'ol' : 'ul';
    out.push(first.ordered && first.start !== 1 ? `<ol start="${first.start}">\n` : `<${tag}>\n`);
    for (const parts of items) {
      const itext = parts.join('\n');
      out.push('<li>');
      inlineTo(itext, link, out, 0, itext.length);
      out.push('</li>\n');
    }
    out.push(`</${tag}>\n`);
  };
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character: a block's kind is decided by it, so
    // most lines need exactly one test instead of a regex each.
    if (line.length === 0) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // Space or tab: blank, or a paragraph line (trimmed below).
      if (isBlank(line)) { i++; continue; }
    } else if (c0 === 96) { // backtick: a fence, or a paragraph
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        out.push('<pre><code' + (lang === '' ? '' : ` class="language-${lang}"`) + '>');
        while (i < n && !isFenceClose(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) { // '#': a heading, or a paragraph
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, slugMemo), ids, idNext);
        const html = inline(hd.text, link);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*': a break, a list, or a paragraph
      if (isHR(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      if (listStart(line) !== null) {
        listBlock();
        continue;
      }
    } else if (c0 === 62) { // '>': a blockquote
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') qlines.push(l);
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const qtext = qlines.join('\n');
        out.push('<blockquote>\n<p>');
        inlineTo(qtext, link, out, 0, qtext.length);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: an ordered list, or a paragraph
      if (listStart(line) !== null) {
        listBlock();
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include. */
// text:    [0, text]
// var/raw: [1|2, path]
// if:      [3, not, path, then, else|null]
// for:     [4, name, path, body]
// include: [5, name]

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t === 'var' ? 1 : 2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', node });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', node });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.node[4] = [];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.node[3] : parent.node[4] ?? parent.node[3];
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in `scope` ({ vars, parent }). `ctx` holds
 * the parsed templates and the include depth. Loop scopes are reused across
 * iterations: rendering is synchronous, so nothing ever observes a stale one.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    switch (nd[0]) {
      case 0:
        out.push(nd[1]);
        break;
      case 1:
        out.push(escapeHtml(textOf(lookup(scope, nd[1]))));
        break;
      case 2:
        out.push(textOf(lookup(scope, nd[1])));
        break;
      case 3: {
        const v = truthy(lookup(scope, nd[2]));
        const branch = v !== nd[1] ? nd[3] : nd[4];
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, nd[2]);
        if (!Array.isArray(xs)) break;
        const sc = { vars: {}, parent: scope };
        const loop = { index: 0, first: false, last: false, length: xs.length };
        sc.vars[nd[1]] = undefined;
        sc.vars.loop = loop;
        for (let k = 0; k < xs.length; k++) {
          sc.vars[nd[1]] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(nd[3], sc, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(nd[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template codegen

/**
 * Scope lookups for generated template code. g1/g2/g3 cover the paths
 * templates actually use (one to three segments); gN is the general case.
 * Each mirrors lookup(): the first name from the nearest scope holding it,
 * then own properties only.
 */
function g1(s, a) {
  let x = s;
  while (x !== null && !Object.hasOwn(x.vars, a)) x = x.parent;
  return x === null ? undefined : x.vars[a];
}
function g2(s, a, b) {
  const v = g1(s, a);
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, b) ? undefined : v[b];
}
function g3(s, a, b, c) {
  const v = g2(s, a, b);
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, c) ? undefined : v[c];
}
function gN(s, path) {
  let x = s;
  while (x !== null && !Object.hasOwn(x.vars, path[0])) x = x.parent;
  if (x === null) return undefined;
  let v = x.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** The helpers generated template code calls, passed in as one object. */
const RT = { g1, g2, g3, gN, esc: escapeHtml, textOf, truthy };

function genLookup(path, scopeVar) {
  if (path.length === 1) return `R.g1(${scopeVar},${JSON.stringify(path[0])})`;
  if (path.length === 2) return `R.g2(${scopeVar},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
  if (path.length === 3) return `R.g3(${scopeVar},${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
  return `R.gN(${scopeVar},${JSON.stringify(path)})`;
}

/**
 * A node tree compiled to JavaScript source: text pushes, values resolve
 * through the scope helpers, if/for become plain control flow, and includes
 * become direct calls (a missing template compiles to nothing, as the
 * interpreter renders nothing for it). `uid` hands out unique temp names
 * and carries the template set, so include targets are resolved at
 * compile time.
 */
function genNodes(nodes, scopeVar, uid) {
  let code = '';
  for (const nd of nodes) {
    switch (nd[0]) {
      case 0:
        code += `out.push(${JSON.stringify(nd[1])});`;
        break;
      case 1:
        code += `out.push(R.esc(R.textOf(${genLookup(nd[1], scopeVar)})));`;
        break;
      case 2:
        code += `out.push(R.textOf(${genLookup(nd[1], scopeVar)}));`;
        break;
      case 3: {
        code += `if(R.truthy(${genLookup(nd[2], scopeVar)})!==${nd[1]}){${genNodes(nd[3], scopeVar, uid)}}`;
        if (nd[4] !== null) code += `else{${genNodes(nd[4], scopeVar, uid)}}`;
        break;
      }
      case 4: {
        const u = uid.next++;
        code += `{const _x${u}=${genLookup(nd[2], scopeVar)};if(Array.isArray(_x${u})){const _s${u}={vars:{},parent:${scopeVar}};const _l${u}={index:0,first:false,last:false,length:_x${u}.length};_s${u}.vars.loop=_l${u};for(let _k${u}=0;_k${u}<_x${u}.length;_k${u}++){_s${u}.vars[${JSON.stringify(nd[1])}]=_x${u}[_k${u}];_l${u}.index=_k${u}+1;_l${u}.first=_k${u}===0;_l${u}.last=_k${u}===_x${u}.length-1;${genNodes(nd[3], `_s${u}`, uid)}}}}`;
        break;
      }
      case 5: {
        if (uid.templates.has(nd[1])) code += `if(depth<8){F[${JSON.stringify(nd[1])}](out,${scopeVar},F,depth+1,R);}`;
        break;
      }
    }
  }
  return code;
}

/**
 * Every parsed template compiled to a function(out, scope, F, depth, R).
 * The include graph is static per build, so each template is compiled once
 * and called directly; a template that includes itself still stops at the
 * depth guard, exactly as the interpreter does.
 */
function compileTemplates(templates) {
  const F = Object.create(null);
  const uid = { next: 0, templates };
  for (const [name, nodes] of templates) {
    F[name] = new Function('out', 'scope', 'F', 'depth', 'R', genNodes(nodes, 'scope', uid));
  }
  return F;
}


// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
function linkOf(s, memo) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-build tables, created fresh on every call: nothing carries over
  // from one case to the next.
  const slugMemo = new Map();
  const linkMemo = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const slugNext = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugMemo), takenIn(dir), slugNext);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
      const c0 = target.charCodeAt(0);
      if (c0 >= 65 && c0 <= 90 || c0 >= 97 && c0 <= 122) {
        let j = 1;
        while (j < target.length) {
          const c = target.charCodeAt(j);
          if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
          j++;
        }
        if (target.charCodeAt(j) === 58) return target; // a scheme: 'https:', 'mailto:', ...
      }
      const key = `${dir}\n${target}`;
      let resolved = linkMemo.get(key);
      if (resolved === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) resolved = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) resolved = `${base}/${path}${frag}`;
        else resolved = null;
        linkMemo.set(key, resolved);
      }
      if (resolved === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return resolved;
    };
    const md = renderMarkdown(s.body, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugMemo);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // Each source carries its own card fields, so the source itself serves as
  // both its page and its card: no per-page objects are built. That is safe
  // because the templates only ever read the documented fields (title, url,
  // date, date_long, summary, excerpt, reading_minutes, tags, slug, content,
  // toc, newer, older, is_post), and those are exactly the ones attached.
  // The neighbours stay link records of four keys, as the templates read
  // only title, url, date and date_long from them.
  for (const s of kept) {
    s.title = s.data.title;
    s.date = s.data.date ?? '';
    s.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    s.summary = s.data.summary ?? '';
    s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.tags = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.content = s.html;
    s.newer = linkOf(s.newer ?? null);
    s.older = linkOf(s.older ?? null);
    s.is_post = s.post;
  }
  for (const t of tags) t.count = t.posts.length;
  const site = { title: input.site.title, base_url: base };
  const recent = posts.slice(0, input.site.recent);
  const ctx = { templates };
  let F = null;
  try {
    F = compileTemplates(templates);
  } catch {
    F = null; // codegen unavailable: the interpreter below renders instead
  }
  // One scope per render kind, reused across renders: each has a fixed set
  // of keys, and the varying field is overwritten before every render, so
  // no stale value can ever leak into another render. Rendering is
  // synchronous, so nothing observes a half-written scope.
  const pageScope = { vars: { site, tags, recent, page: null }, parent: null };
  const indexScope = { vars: { site, tags, recent, posts: null, pager: null }, parent: null };
  const tagScope = { vars: { site, tags, recent, tag: null }, parent: null };
  const tagsScope = { vars: { site, tags, recent }, parent: null };
  const output = {};
  const render = (name, scope) => {
    if (F !== null) {
      const fn = F[name];
      if (fn === undefined) return null;
      const out = [];
      fn(out, scope, F, 0, RT);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    pageScope.vars.page = s;
    output[`${s.outDir}/index.html`] = render(s.layout, pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexScope.vars.posts = posts.slice((k - 1) * per, k * per);
    indexScope.vars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagScope.vars.tag = t;
    const html = render('tag', tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsScope);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
