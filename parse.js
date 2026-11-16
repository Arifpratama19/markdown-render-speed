// A fast, dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its default options
// (gfm on, breaks off, pedantic off). Written from scratch from the
// CommonMark 0.31.2 + GFM 0.29 rules and marked's documented behaviour,
// optimised for speed: the token loops run on index cursors with sticky
// regexes instead of repeatedly slicing the remaining source.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
// A bare & is only an entity start when it begins a valid reference.
const ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escHtml(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_REPLACE, c => ESC_MAP[c]);
  } else if (ESC_TEST_NOENC.test(s)) {
    return s.replace(ESC_REPLACE_NOENC, c => ESC_MAP[c]);
  }
  return s;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references in inline text; a bare & that does
// not start a valid reference becomes &amp; (only when a numeric reference
// is present at all, otherwise the string is left untouched and the
// renderer's escHtml handles the ampersand).
function unescEnt(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Clean a link/image href the way marked does: encodeURI, then restore %.
function cleanHref(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, trim the cells, drop an empty
// leading/trailing cell, and (when count is given) pad or truncate to it.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let esc = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip trailing characters: when flag is false, strip chars equal to ch;
// when true, strip chars different from ch.
function trimTail(s, ch, flag) {
  const n = s.length;
  if (n === 0) return '';
  let i = 0;
  for (; i < n;) {
    const c = s.charAt(n - i - 1);
    if (c === ch && !flag) i++;
    else if (c !== ch && flag) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Drop trailing blank lines, keeping at most one blank line at the end.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link-reference label: trim, collapse whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of an unmatched close paren in s (pair is e.g. '()').
// Returns -1 when balanced, -2 when an open paren is never closed.
function parenIdx(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, to the next multiple of 4, starting at column col.
function expandTabs(s, col = 0) {
  let out = '';
  let pos = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const n = 4 - (pos % 4);
      out += ' '.repeat(n);
      pos += n;
    } else {
      out += ch;
      pos++;
    }
  }
  return out;
}

// A fenced block whose fence line is indented: dedent each content line by
// that indent (at most the line's own leading whitespace).
function fenceDedent(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const ind = m[1];
  return text.split('\n').map(line => {
    const lead = line.match(/^\s+/);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, ind.length));
  }).join('\n');
}

// True when the link label starting at offset off in src contains a raw
// HTML tag or autolink that runs past the end of the label: such a link is
// not a link at all.
function hasHtmlLink(src, label, off, rx) {
  if (!src.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = rx.code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(off + i);
    const m = rx.tag.exec(rest) || rx.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token from a matched link, tokenising its label
// text for nested emphasis etc. Returns null when a link's label itself
// contains a link (nested links are not links).
function makeLink(m, href, title, raw, lexer, isImage) {
  const label = m[1].replace(/\\([\[\]])/g, '$1');
  const prevInLink = lexer.state.inLink;
  const prevEmitted = lexer.state.linkEmitted;
  const prevRaw = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(label);
  const emitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = prevEmitted;
  lexer.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      lexer.state.inRawBlock = prevRaw;
      return null;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title: title || null,
    text: label,
    tokens,
  };
}

// ---------------------------------------------------------------------------
// Patterns. Block and inline rules are built from the same grammar pieces
// marked uses (CommonMark 0.31.2 + GFM 0.29), composed here from named
// parts so each rule reads as one pattern. `buildRx` substitutes a named
// part into a template and strips a leading ^ from the part (a sub-pattern
// anchored in its own rule must not re-anchor inside a larger one).
// ---------------------------------------------------------------------------

const CARET_STRIP = /(^|[^\[])\^/g;
// Drop match-start ^ anchors from a pattern. The sticky `y` flag already
// pins every match to the cursor, and a ^ only matches at position 0 (or,
// with `m`, at a line start), so it breaks any rule tried past the start.
// A ^ that negates a character class ([^...]) or is escaped (\^) is kept.
function stripAnchors(s, keepLead = false) {
  let out = '';
  let inClass = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { out += c; escaped = false; continue; }
    if (c === '\\') { out += c; escaped = true; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    if (c === ']') { inClass = false; out += c; continue; }
    if (c === '^' && !inClass) {
      if (out.length === 0) { if (!keepLead) continue; }
      else {
        const prev = out[out.length - 1];
        if (prev === '(' || prev === '|') continue;
        if (out.endsWith('(?:') || out.endsWith('(?=') || out.endsWith('(?!') ||
            out.endsWith('(?<!') || out.endsWith('(?<=')) continue;
      }
    }
    out += c;
  }
  return out;
}

function buildRx(template, subs, flags = 'y', keepLeadAnchor = false) {
  let s = typeof template === 'string' ? template : template.source;
  const entries = Object.entries(subs);
  // Phase 1: swap every key for a unique sentinel. Longest keys first, so
  // a key that contains another (lheading/heading, blockCode/code) is not
  // half-eaten by the shorter one. Phase 2 then swaps each sentinel for
  // its value, so a value that mentions another key's name (the HTML tag
  // list contains "blockquote", "table", "html" ...) is never re-scanned.
  const order = entries.map((e, i) => i).sort((a, b) => entries[b][0].length - entries[a][0].length);
  const sentinels = entries.map((_, i) => `\u0001${i}\u0002`);
  for (const i of order) s = s.split(entries[i][0]).join(sentinels[i]);
  for (let i = 0; i < entries.length; i++) {
    let rep = typeof entries[i][1] === 'string' ? entries[i][1] : entries[i][1].source;
    rep = rep.replace(CARET_STRIP, '$1');
    s = s.split(sentinels[i]).join(rep);
  }
  return new RegExp(stripAnchors(s, keepLeadAnchor), flags);
}

// Block-level tag names that may start an HTML block (types 1-6).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Small shared patterns (the "other" set).
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'\"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  outputLinkReplace: /\\([\[\]])/g,
};
// Parameterised block-start checks, memoised by indent (0..3).
const _memo = new Map();
function memoRx(key, make) {
  let r = _memo.get(key);
  if (!r) { r = make(); _memo.set(key, r); }
  return r;
}
const listItemRx = b => memoRx('li:' + b, () => new RegExp(`( {0,3}${b})((?:[\\t ][^\\n]*)?(?:\\n|$))`, 'y'));
const nextBulletRx = n => memoRx('nb:' + n, () => new RegExp(` {0,${Math.min(Math.max(n-1,0),3)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`, 'y'));
const hrRx = n => memoRx('hr:' + n, () => new RegExp(` {0,${Math.min(Math.max(n-1,0),3)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`, 'y'));
const fencesBeginRx = n => memoRx('fb:' + n, () => new RegExp(` {0,${Math.min(Math.max(n-1,0),3)}}(?:\`\`\`|~~~)`, 'y'));
const headingBeginRx = n => memoRx('hb:' + n, () => new RegExp(` {0,${Math.min(Math.max(n-1,0),3)}}#{1,6}(?:\\s|$)`, 'y'));
const htmlBeginRx = n => memoRx('htmlb:' + n, () => new RegExp(` {0,${Math.min(Math.max(n-1,0),3)}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'iy'));
const blockquoteBeginRx = n => memoRx('bq:' + n, () => new RegExp(` {0,${Math.min(Math.max(n-1,0),3)}}>`, 'y'));

// --- Block rules (GFM set) -----------------------------------------------
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[\\t ]*){3,}|(?:\\*[\\t ]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_START_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_START_SRC = ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const LIST_BULL_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';

// Paragraph core: a run of lines that does not start a new block.
const PARA_CORE = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
// The table rule must exist before the paragraph can cite it; build it first.
const TABLE_SRC = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
const tableRx = buildRx(TABLE_SRC, {
  hr: HR_SRC,
  heading: HEADING_SRC,
  blockquote: ' {0,3}>',
  code: '(?: {4}| {0,3}\\t)[^\\n]',
  fences: FENCES_START_SRC,
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  html: HTML_START_SRC,
  tag: BLOCK_TAGS,
});
// Now the paragraph, citing the table pattern.
const paraGfmRx = buildRx(PARA_CORE, {
  hr: HR_SRC,
  heading: HEADING_SRC,
  '|lheading': '',
  table: tableRx.source,
  blockquote: ' {0,3}>',
  fences: FENCES_START_SRC,
  // Only a non-empty item can interrupt a paragraph, and only a `1.`
  // ordered list (not 2., 3., ...) may do so.
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  html: HTML_START_SRC,
});

// Setext-heading core.
const LHEADING_CORE = '^(?!(?:bull |blockCode|fences|blockquote|heading|html|table))((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const lheadingGfmRx = buildRx(LHEADING_CORE, {
  bull: LIST_BULL_SRC,
  blockCode: '(?: {4}| {0,3}\\t)',
  fences: ' {0,3}(?:`{3,}|~{3,})',
  blockquote: ' {0,3}>',
  heading: HEADING_SRC,
  // Non-capturing here: a capturing group inside this lookahead would
  // shift the underline (group 2) to group 3.
  hr: ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[\\t ]*){3,}|(?:\\*[\\t ]*){3,})(?:\\n+|$)',
  html: ' {0,3}<[^\\n>]+>\\n',
  table: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
});

// HTML block (types 1-7), case-insensitive.
const HTML_BLOCK_SRC = '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))';
const htmlBlockRx = buildRx(HTML_BLOCK_SRC, {
  comment: '<!--(?:-?>|[\\s\\S]*?(?:-->|$))',
  tag: BLOCK_TAGS,
  attribute: ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?',
}, 'iy');

// Link reference definition.
const LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_SRC = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const defRx = buildRx('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)', {
  label: LABEL_SRC,
  title: TITLE_SRC,
});

// Blockquote: a run of > lines plus paragraph continuations.
const blockquoteRx = buildRx('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+', {
  paragraph: paraGfmRx.source,
});

const BLOCK = {
  newline: /(?:[ \t]*(?:\n|$))+/y,
  code: /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y,
  fences: / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y,
  hr: new RegExp(HR_SRC, 'y'),
  heading: / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y,
  lheading: lheadingGfmRx,
  paragraph: paraGfmRx,
  text: /[^\n]+/y,
  def: defRx,
  list: /( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/y,
  blockquote: blockquoteRx,
  html: htmlBlockRx,
  table: tableRx,
};

// --- Inline rules (GFM set) ----------------------------------------------
const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_NOT_TILDE = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_NOT_TILDE = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';
const EMAIL_CHARS = "[a-zA-Z0-9.!#$%&'*+\\/=?^_`{|}~-]";
const EMAIL = `${EMAIL_CHARS}+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])`;
const EMAIL_BARE = '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const PROTO = '[hH][tT][tT][pP][sS]?|[fF][tT][pP]';

// Emphasis delimiter runs. The left-delimiter rule reports the run and
// whether the character after it is punctuation or whitespace; the
// right-delimiter rules (global+sticky) are scanned for a matching closer.
const emLDelimRx = new RegExp(`(?:\\*+(?:((?!\\*)${PUNCT_NOT_TILDE})|([^\\s*]))?)|_+(?:((?!_)${PUNCT_NOT_TILDE})|([^\\s_]))?`, 'yu');
const RDELIM_AST_SRC = `^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)`;
const RDELIM_UND_SRC = `^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`;
const emRDelimAstRx = buildRx(RDELIM_AST_SRC, {
  notPunctSpace: NOT_PUNCT_SPACE_TILDE,
  punctSpace: PUNCT_SPACE_NOT_TILDE,
  punct: PUNCT_NOT_TILDE,
}, 'gu', true);
const emRDelimUndRx = buildRx(RDELIM_UND_SRC, {
  notPunctSpace: NOT_PUNCT_SPACE,
  punctSpace: PUNCT_SPACE,
  punct: PUNCT,
}, 'gu', true);
const punctRx = new RegExp(`^((?![*_])${PUNCT_SPACE})`, 'u');
const delLDelimRx = new RegExp(`~~?(?:((?!~)${PUNCT})|[^\\s~])`, 'yu');
const RDELIM_DEL_SRC = `^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`;
const delRDelimRx = buildRx(RDELIM_DEL_SRC, {
  notPunctSpace: NOT_PUNCT_SPACE,
  punctSpace: PUNCT_SPACE,
  punct: PUNCT,
}, 'gu', true);

// Link label pieces.
const BRACKETED = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LINK_LABEL = `(?:\\[(?:${BRACKETED}|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\`\`+(?=\\])|[^\\[\\]\\\\\`])*?`;
const REF_LABEL = `(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+`;
const REF_LABEL_LOOSE = `(?:[^\\[\\]\\\\\`]*(?:\\[(?:${BRACKETED}|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\`\`+(?=\\])){0,999}?[^\\[\\]\\\\\`]*?)`;
const REF_TEXT = `(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}`;

const INLINE = {
  escape: /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y,
  code: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
  br: /( {2,}|\\)\n(?!\s*$)[ \t]*/y,
  text: buildRx(`^(?:[^a-zA-Z0-9](?=emailProtocol)|(\`+|~+|[^\`~])(?:(?=[\`~])|(?= {2,}\\n)|(?=${EMAIL_CHARS}+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[\`*~_]|\\b_|protocol:\\/\\/|wwwStart|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\\/=?_\`{|}~-](?=${EMAIL_CHARS}+@))))`, {
    protocol: PROTO,
    emailProtocol: '(?:mailto|xmpp):',
    wwwStart: '(?<![^\\s*_~(])www\\.',
  }),
  autolink: buildRx(`^<(scheme:[^\\s\\x00-\\x1f<>]*|email)>`, {
    scheme: '[a-zA-Z][a-zA-Z0-9+.-]{1,31}',
    email: `${EMAIL_CHARS}+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])`,
  }),
  tag: buildRx(`^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`, {
    comment: '<!--(?:-?>|[\\s\\S]*?-->)',
    attribute: `\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s"'=<>\\\`]+)?`,
  }),
  link: buildRx(`^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)`, {
    label: LINK_LABEL,
    href: `<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))`,
    title: `"(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)`,
  }),
  reflink: buildRx(`^!?\\[(label)\\]\\[(ref)\\]`, { label: LINK_LABEL, ref: REF_LABEL }),
  nolink: buildRx(`^!?\\[(ref)\\](?:\\[\\])?`, { ref: REF_LABEL }),
  reflinkSearch: buildRx(`reflink|nolink(?!\\()`, {
    // The label/ref patterns are inlined here (not via nested placeholders)
    // because buildRx does not resolve placeholders inside a value.
    reflink: `^!?\\[(${REF_LABEL_LOOSE})\\]\\[(${REF_TEXT})\\]`,
    nolink: `^!?\\[(${REF_TEXT})\\](?:\\[\\])?`,
  }, 'g'),
  url: buildRx(`^(?:mailto:email|xmpp:email(?:\\/[A-Za-z0-9@.]+)?)|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^bareEmail`, {
    bareEmail: EMAIL_BARE,
    email: EMAIL,
    protocol: PROTO,
  }),
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\~])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/y,
  _backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/y,
  blockSkip: buildRx(`link|precode-code|html`, {
    link: `\\[(?:[^\\[\\]\`]|(?<a>\`+)[^\`]+\\k<a>(?!\`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)`,
    'precode-': '(?<!`)()',
    code: `(?<b>\`+)[^\`]+\\k<b>(?!\`)`,
    html: `<(?! )[^<>]*?>`,
  }, 'g'),
};
// Fill in the punctuation class for the masking helpers.
INLINE.anyPunctuation = buildRx('\\\\(punct)', { punct: PUNCT }, 'gu');
INLINE.anyPunctuationOutsideCode = buildRx('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(punct)', { punct: PUNCT }, 'gu');

// ---------------------------------------------------------------------------
// Block tokenizer. Each rule takes (lx, src, pos) and returns {tok, next}
// or null. `src` is the whole source string, `pos` the cursor; sticky
// regexes match at the cursor without slicing the source.
// ---------------------------------------------------------------------------

function execAt(rx, src, pos) {
  rx.lastIndex = pos;
  return rx.exec(src);
}
// First line of src at pos, without its newline; next = position after it.
function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return { line: src.slice(pos), next: src.length };
  return { line: src.slice(pos, nl), next: nl + 1 };
}

const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;

function tokSpace(lx, src, pos) {
  const m = execAt(BLOCK.newline, src, pos);
  if (m && m[0].length > 0) return { tok: { type: 'space', raw: m[0] }, next: pos + m[0].length };
  return null;
}

function tokCode(lx, src, pos) {
  const m = execAt(BLOCK.code, src, pos);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  const text = raw.replace(O.codeRemoveIndent, '');
  return { tok: { type: 'code', raw, codeBlockStyle: 'indented', text }, next: pos + raw.length };
}

function tokFences(lx, src, pos) {
  const m = execAt(BLOCK.fences, src, pos);
  if (!m) return null;
  const raw = m[0];
  const text = fenceDedent(raw, m[3] || '');
  const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2];
  return { tok: { type: 'code', raw, lang, text }, next: pos + raw.length };
}

function tokHeading(lx, src, pos) {
  const m = execAt(BLOCK.heading, src, pos);
  if (!m) return null;
  let text = m[2].trim();
  if (O.endingHash.test(text)) {
    const s = trimTail(text, '#');
    if (!s || O.endingSpaceTabChar.test(s)) text = s.trim();
  }
  const raw = trimTail(m[0], '\n');
  return {
    tok: { type: 'heading', raw, depth: m[1].length, text, tokens: lx.inline(text) },
    next: pos + raw.length,
  };
}

function tokHr(lx, src, pos) {
  const m = execAt(BLOCK.hr, src, pos);
  if (!m) return null;
  const raw = trimTail(m[0], '\n');
  return { tok: { type: 'hr', raw }, next: pos + raw.length };
}

function tokHtml(lx, src, pos) {
  const m = execAt(BLOCK.html, src, pos);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return {
    tok: { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw },
    next: pos + raw.length,
  };
}

function tokDef(lx, src, pos) {
  const m = execAt(BLOCK.def, src, pos);
  if (!m) return null;
  if (!O.startAngleBracket.test(m[2]) && parenIdx(m[2], '()') !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3];
  const raw = trimTail(m[0], '\n');
  return { tok: { type: 'def', tag, raw, href, title }, next: pos + raw.length };
}

function tokTable(lx, src, pos) {
  const m = execAt(BLOCK.table, src, pos);
  if (!m || !O.tableDelimiter.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(O.tableAlignChars, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  const tok = { type: 'table', raw: trimTail(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== aligns.length) return null;
  for (const a of aligns) {
    if (O.tableAlignRight.test(a)) tok.align.push('right');
    else if (O.tableAlignCenter.test(a)) tok.align.push('center');
    else if (O.tableAlignLeft.test(a)) tok.align.push('left');
    else tok.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    tok.header.push({ text: headerCells[i], tokens: lx.inline(headerCells[i]), header: true, align: tok.align[i] });
  }
  for (const row of rows) {
    tok.rows.push(splitCells(row, tok.header.length).map((cell, i) => ({
      text: cell, tokens: lx.inline(cell), header: false, align: tok.align[i],
    })));
  }
  return { tok, next: pos + tok.raw.length };
}

function tokLheading(lx, src, pos) {
  const m = execAt(BLOCK.lheading, src, pos);
  if (!m) return null;
  const text = m[1].trim();
  const raw = trimTail(m[0], '\n');
  return {
    tok: { type: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: lx.inline(text) },
    next: pos + raw.length,
  };
}

function tokParagraph(lx, src, pos) {
  const m = execAt(BLOCK.paragraph, src, pos);
  if (!m) return null;
  let text = m[1];
  if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
  return { tok: { type: 'paragraph', raw: m[0], text, tokens: lx.inline(text) }, next: pos + m[0].length };
}

function tokText(lx, src, pos) {
  const m = execAt(BLOCK.text, src, pos);
  if (!m) return null;
  return { tok: { type: 'text', raw: m[0], text: m[0], tokens: lx.inline(m[0]) }, next: pos + m[0].length };
}

function tokBlockquote(lx, src, pos) {
  const m = execAt(BLOCK.blockquote, src, pos);
  if (!m) return null;
  let lines = trimTail(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let seen = false;
    const group = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (O.blockquoteStart.test(lines[p])) { group.push(lines[p]); seen = true; }
      else if (!seen) group.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = group.join('\n');
    const u = h
      .replace(O.blockquoteMarkerWhitespace, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${h}` : h;
    text = text ? `${text}\n\n${u}\n` : u;
    const prevTop = lx.state.top;
    lx.state.top = true;
    blockTokens(lx, u, tokens, true);
    lx.state.top = prevTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) break;
    if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote') {
      const g = last;
      const rest = lines.join('\n');
      const combined = g.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
      const f = tokBlockquote(lx, combined, 0);
      tokens[tokens.length - 1] = f.tok;
      const y = combined.substring(f.tok.raw.length).replace(/^\n/, '');
      const rCount = y ? y.split('\n').length : 0;
      const taken = rCount ? lines.slice(0, -rCount) : lines;
      if (taken.length > 0) {
        raw = `${raw}\n${taken.join('\n')}`;
        text = text.substring(0, text.length - g.text.length) + f.tok.text;
        lines = lines.slice(taken.length);
        if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      }
      break;
    } else if (last.type === 'list') {
      const g = last;
      const combined = g.raw + '\n' + lines.join('\n');
      const f = tokList(lx, combined, 0);
      tokens[tokens.length - 1] = f.tok;
      const extra = f.tok.raw.length > g.raw.length
        ? combined.slice(g.raw.length + 1, f.tok.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join('\n');
        raw = `${raw}\n${y}`;
        text = `${text}\n\n${y}\n`;
      }
      lines = lines.slice(extra);
      continue;
    }
    // Otherwise (paragraph/text/...) the loop continues: the remaining
    // lines are lazy continuations of this blockquote, not a new block.
  }
  return { tok: { type: 'blockquote', raw, tokens, text }, next: pos + raw.length };
}

function tokList(lx, src, pos) {
  const m = execAt(BLOCK.list, src, pos);
  if (!m) return null;
  const origin = pos;
  const bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const listTok = {
    type: 'list', raw: '', ordered,
    start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [],
  };
  const bulletRe = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRx = listItemRx(bulletRe);
  let looseSeen = false;
  let p = pos;
  while (p < src.length) {
    let emptyItem = false;
    let itemText = '';
    const it = execAt(itemRx, src, p);
    if (!it || execAt(BLOCK.hr, src, p)) break;
    const itemStart = p;
    p += it[0].length;
    const g = it[2].split('\n', 1)[0];
    const bLen = it[1].length;
    const ws = g.replace(O.leadingSpaceTab, v => expandTabs(v, bLen));
    const nextLine = lineAt(src, p).line;
    let prevBlank = !ws.trim();
    let indent;
    if (prevBlank) {
      indent = bLen + 1;
    } else {
      indent = ws.search(O.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = ws.slice(indent);
      indent += bLen;
    }
    if (prevBlank && O.blankLine.test(nextLine)) {
      p += nextLine.length + 1;
      emptyItem = true;
    }
    if (!emptyItem) {
      const bulletRx = nextBulletRx(indent);
      const hrR = hrRx(indent);
      const fenceR = fencesBeginRx(indent);
      const headR = headingBeginRx(indent);
      const htmlR = htmlBeginRx(indent);
      const bqR = blockquoteBeginRx(indent);
      let curWs = ws;
      while (p < src.length) {
        const cur = lineAt(src, p);
        const line = cur.line;
        const disp = line.replace(O.leadingSpaceTab, v => expandTabs(v));
        if (execAt(fenceR, src, p) || execAt(headR, src, p) || execAt(htmlR, src, p) ||
            execAt(bqR, src, p) || execAt(bulletRx, src, p) || execAt(hrR, src, p)) break;
        if (disp.search(O.nonSpaceChar) >= indent || !line.trim()) {
          itemText += '\n' + disp.slice(indent);
        } else {
          if (prevBlank || curWs.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 ||
              execAt(fenceR, curWs, 0) || execAt(headR, curWs, 0) || execAt(htmlR, curWs, 0) || execAt(hrR, curWs, 0)) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(line) &&
            execAt(BLOCK.lheading, `${curWs}\n${line}`, 0);
          const lazy = setext ? `    ${disp.replace(/^ {0,3}/, '')}` : line;
          itemText += '\n' + lazy;
        }
        prevBlank = !line.trim();
        p = cur.next;
        curWs = disp.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, p);
    if (!listTok.loose) {
      if (looseSeen) listTok.loose = true;
      else if (O.doubleBlankLine.test(itemRaw)) looseSeen = true;
    }
    listTok.items.push({
      type: 'list_item', raw: itemRaw,
      task: O.listIsTask.test(itemText), loose: false, text: itemText, tokens: [],
    });
  }
  const lastItem = listTok.items[listTok.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  listTok.raw = src.slice(origin, p).trimEnd();
  for (const item of listTok.items) {
    lx.state.top = false;
    item.tokens = blockTokens(lx, item.text, [], false);
    if (!listTok.loose) {
      const spaces = item.tokens.filter(t => t.type === 'space');
      if (spaces.length > 0 && spaces.some(t => O.anyLine.test(t.raw))) listTok.loose = true;
    }
  }
  for (const item of listTok.items) {
    const first = item.tokens[0];
    if (item.task && (first && (first.type === 'text' || first.type === 'paragraph'))) {
      item.text = item.text.replace(O.listReplaceTask, '');
      first.raw = first.raw.replace(O.listReplaceTask, '');
      first.text = first.text.replace(O.listReplaceTask, '');
      for (let i = lx.inlineQueue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(lx.inlineQueue[i].src)) {
          lx.inlineQueue[i].src = lx.inlineQueue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const cb = O.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = box.checked;
        if (listTok.loose && item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
          item.tokens[0].raw = box.raw + item.tokens[0].raw;
          item.tokens[0].text = box.raw + item.tokens[0].text;
          item.tokens[0].tokens.unshift(box);
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (listTok.loose) {
    for (const item of listTok.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return { tok: listTok, next: origin + listTok.raw.length };
}

// ---------------------------------------------------------------------------
// Inline tokenizer. Rules run on an index cursor over the inline source;
// the emphasis/delimiter scans run on a masked copy of the same source
// (link, code and tag interiors hidden) so a * inside a link or a code span
// can never open emphasis.
// ---------------------------------------------------------------------------

// Last positions in the masked source where a *, _ or ~ run could close.
function scanClosers(masked) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: masked, em, del };
}

// Hide reflinks, punctuation escapes, links, code spans and tags from the
// emphasis scan: their interiors become runs of 'a' (links/code) or '+'
// (escaped punctuation), keeping every length unchanged.
function maskForEm(lx, src) {
  let t = src;
  if (lx.linksCount > 0 && src.includes('[')) {
    const re = INLINE.reflinkSearch;
    const replaceRef = r => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (lx.linkInText(inner)) {
          return '[' + inner.replace(re, replaceRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, replaceRef);
  }
  t = t.replace(INLINE.anyPunctuationOutsideCode, (n, s, r) => {
    if (r) return '+'.repeat(n.length);
    if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
    return n;
  });
  t = t.replace(INLINE.blockSkip, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

function tokInlineEscape(lx, src, pos) {
  const m = execAt(INLINE.escape, src, pos);
  if (!m) return null;
  return { tok: { type: 'escape', raw: m[0], text: m[1] }, next: pos + m[0].length };
}

function tokInlineTag(lx, src, pos) {
  const m = execAt(INLINE.tag, src, pos);
  if (!m) return null;
  if (!lx.state.inLink && O.startATag.test(m[0])) lx.state.inLink = true;
  else if (lx.state.inLink && O.endATag.test(m[0])) lx.state.inLink = false;
  if (!lx.state.inRawBlock && O.startPreScriptTag.test(m[0])) lx.state.inRawBlock = true;
  else if (lx.state.inRawBlock && O.endPreScriptTag.test(m[0])) lx.state.inRawBlock = false;
  return {
    tok: { type: 'html', raw: m[0], inLink: lx.state.inLink, inRawBlock: lx.state.inRawBlock, block: false, text: m[0] },
    next: pos + m[0].length,
  };
}

function tokInlineLink(lx, src, pos) {
  if (lx.state.linkParenPossible === false) return null;
  const m = execAt(INLINE.link, src, pos);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasHtmlLink(src.slice(pos), m[1], bang, INLINE)) return null;
  let href = m[2].trim();
  if (O.startAngleBracket.test(href)) {
    if (!O.endAngleBracket.test(href)) return null;
    const stripped = trimTail(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const idx = parenIdx(m[2], '()');
    if (idx === -2) return null;
    if (idx > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + idx;
      m[2] = m[2].substring(0, idx);
      href = m[2];
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const rawEnd = trimTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawEnd.length) % 2 === 0) return null;
  let title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  const tok = makeLink(m, href && href.replace(ANY_PUNCT, '$1'), title && title.replace(ANY_PUNCT, '$1'), m[0], lx, bang === 2);
  if (!tok) return null;
  return { tok, next: pos + m[0].length };
}

function tokInlineReflink(lx, src, pos) {
  let m = execAt(INLINE.reflink, src, pos);
  if (!m) m = execAt(INLINE.nolink, src, pos);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasHtmlLink(src.slice(pos), m[1], bang, INLINE)) return null;
  const def = lx.links[normLabel(m[2] || m[1])];
  if (!def) {
    const ch = m[0].charAt(0);
    return { tok: { type: 'text', raw: ch, text: ch }, next: pos + 1 };
  }
  const tok = makeLink(m, def.href, def.title, m[0], lx, bang === 2);
  if (!tok) return null;
  return { tok, next: pos + m[0].length };
}

// The emphasis/strong opener at pos. `masked` is the masked inline source,
// `scan` its closer scan, `prev` the last character of the previous token.
function tokEmStrong(lx, src, masked, scan, pos, prev) {
  const m = execAt(emLDelimRx, src, pos);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const r = m[0][0];
  const isPrevDelim = prev === r;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const before = l > 0 ? masked[l - 1] : '';
  const isPunctBefore = before === '*' || before === '_' || (before !== '' && punctRx.test(before));
  let n = prev;
  if (l < i) n = before;
  const u = l < i ? isPunctBefore : (n !== '' && punctRx.test(n));
  if (m[4] && O.unicodeAlphaNumeric.test(n)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !n || u) {
    const k = [...m[0]].length - 1;
    let openLeft = k;
    let overflow = 0;
    const y = i - l + k;
    const R = before.trim() !== '' && (!!d || (r === '*' && !isPunctBefore));
    if (r !== '*' && r !== '_') return null;
    const delimRx = r === '*' ? emRDelimAstRx : emRDelimUndRx;
    const lastCloser = scan.em[r];
    const afterOpener = i + k;
    if (lastCloser < afterOpener) return null;
    // Scan the tail after the opener (like marked): the leading ^ in the
    // first skip alternative then anchors at the opener, not at pos 0.
    const sliced = masked.slice(afterOpener);
    const lastCloserSliced = lastCloser - afterOpener;
    delimRx.lastIndex = 0;
    let sm;
    while ((sm = delimRx.exec(sliced)) !== null && !(sm.index > lastCloserSliced)) {
      const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!g) continue;
      let b = [...g].length;
      if (sm[3] || sm[4]) { openLeft += b; continue; }
      if (sm[5] || sm[6] || R) {
        if (isPrevDelim && (sm[5] || sm[6])) break;
        if (y % 3 && !((y + b) % 3)) { overflow += b; continue; }
      }
      openLeft -= b;
      if (openLeft > 0) continue;
      b = Math.min(b, b + openLeft + overflow);
      const firstLen = [...sm[0]][0].length;
      const rawLen = k + sm.index + firstLen + b;
      const rawEnd = pos + rawLen;
      if (Math.min(k, b) % 2) {
        const text = src.slice(pos + 1, rawEnd - 1);
        return { tok: { type: 'em', raw: src.slice(pos, rawEnd), text, tokens: lx.inlineTokens(text) }, next: rawEnd };
      }
      const text = src.slice(pos + 2, rawEnd - 2);
      return { tok: { type: 'strong', raw: src.slice(pos, rawEnd), text, tokens: lx.inlineTokens(text) }, next: rawEnd };
    }
  }
  return null;
}

function tokCodespan(lx, src, pos) {
  const m = execAt(INLINE.code, src, pos);
  if (!m) return null;
  let text = m[2].replace(O.newLineCharGlobal, ' ');
  const hasNonSpace = O.nonSpaceChar.test(text);
  const padded = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
  if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
  return { tok: { type: 'codespan', raw: m[0], text }, next: pos + m[0].length };
}

function tokBr(lx, src, pos) {
  const m = execAt(INLINE.br, src, pos);
  if (!m) return null;
  return { tok: { type: 'br', raw: m[0] }, next: pos + m[0].length };
}

function tokDel(lx, src, masked, scan, pos, prev) {
  const m = execAt(delLDelimRx, src, pos);
  if (!m) return null;
  // Attempt only when the character after the opener is not punctuation,
  // or there is no previous character, or the previous character is
  // punctuation.
  const afterIsPunct = !!(m[1] || '');
  if (afterIsPunct && prev && !punctRx.test(prev)) return null;
  const openerLen = [...m[0]].length - 1;
  let openLeft = openerLen;
  const delimRx = delRDelimRx;
  const lastCloser = scan.del;
  const afterOpener = pos + openerLen;
  if (lastCloser < afterOpener) return null;
  const sliced = masked.slice(afterOpener);
  const lastCloserSliced = lastCloser - afterOpener;
  delimRx.lastIndex = 0;
  let sm;
  while ((sm = delimRx.exec(sliced)) !== null && !(sm.index > lastCloserSliced)) {
    const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
    if (!g) continue;
    let b = [...g].length;
    if (b !== openerLen) continue;
    if (sm[3] || sm[4]) { openLeft += b; continue; }
    openLeft -= b;
    if (openLeft > 0) continue;
    b = Math.min(b, b + openLeft);
    const firstLen = [...sm[0]][0].length;
    const rawLen = openerLen + sm.index + firstLen + b;
    const rawEnd = pos + rawLen;
    const text = src.slice(pos + openerLen, rawEnd - openerLen);
    return { tok: { type: 'del', raw: src.slice(pos, rawEnd), text, tokens: lx.inlineTokens(text) }, next: rawEnd };
  }
  return null;
}

function tokAutolink(lx, src, pos) {
  const m = execAt(INLINE.autolink, src, pos);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
  else { text = m[1]; href = text; }
  return {
    tok: { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] },
    next: pos + m[0].length,
  };
}

function tokUrl(lx, src, pos) {
  const m = execAt(INLINE.url, src, pos);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let raw = m[0];
    let prev;
    do {
      prev = raw;
      const b = execAt(INLINE._backpedal, raw, 0);
      raw = b ? b[0] : '';
    } while (prev !== raw);
    text = raw;
    href = m[1] === 'www.' ? 'http://' + raw : raw;
  }
  return {
    tok: { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] },
    next: pos + text.length,
  };
}

function tokInlineText(lx, src, pos, inRawBlock) {
  const m = execAt(INLINE.text, src, pos);
  if (!m) return null;
  const text = inRawBlock ? m[0] : unescEnt(m[0]);
  return { tok: { type: 'text', raw: m[0], text, escaped: inRawBlock }, next: pos + m[0].length };
}

// ---------------------------------------------------------------------------
// Lexer. Block tokenisation queues inline work (the inline queue) instead of
// running it immediately, so link definitions found later in the document
// still resolve for paragraphs that came first. lex() drains the queue after
// the whole block pass.
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.links = this.tokens.links;
    this.linksCount = 0;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    blockTokens(this, src, this.tokens, false);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue an inline tokenisation; returns the (initially empty) token list
  // that lex() will fill in once the whole block pass is done.
  inline(src) {
    const tokens = [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  // True when src contains a link (inline or reference) that is not an
  // image and whose label resolves to a known definition.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (execAt(INLINE.link, m[0], 0) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.links, normLabel(s.slice(r + 1, -1)))) &&
          !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.inlineLoop(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineLoop(src, tokens) {
    const needMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needMask ? maskForEm(this, src) : src;
    const scan = needMask ? scanClosers(masked) : { em: { '*': -1, _: -1 }, del: -1 };
    let isText = false;
    let prev = '';
    let guard = Infinity;
    let pos = 0;
    const len = src.length;
    while (pos < len) {
      if (len - pos < guard) guard = len - pos;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
      if (!isText) prev = '';
      isText = false;
      let r;
      if (r = tokInlineEscape(this, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokInlineTag(this, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokInlineLink(this, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokInlineReflink(this, src, pos)) {
        pos = r.next;
        const last = tokens[tokens.length - 1];
        if (r.tok.type === 'text' && last && last.type === 'text') { last.raw += r.tok.raw; last.text += r.tok.text; }
        else tokens.push(r.tok);
        continue;
      }
      if (r = tokEmStrong(this, src, masked, scan, pos, prev)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokCodespan(this, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokBr(this, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokDel(this, src, masked, scan, pos, prev)) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokAutolink(this, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
      if (!this.state.inLink && (r = tokUrl(this, src, pos))) { pos = r.next; tokens.push(r.tok); continue; }
      if (r = tokInlineText(this, src, pos, this.state.inRawBlock)) {
        pos = r.next;
        if (r.tok.raw.slice(-1) !== '_') prev = r.tok.raw.slice(-1);
        isText = true;
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') { last.raw += r.tok.raw; last.text += r.tok.text; }
        else tokens.push(r.tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
    return tokens;
  }
}

// Block tokenisation over a cursor. `mergePara` is true only for the inside
// of a blockquote, where a paragraph may merge with a preceding paragraph.
function blockTokens(lx, src, tokens, mergePara) {
  let guard = Infinity;
  let pos = 0;
  const len = src.length;
  while (pos < len) {
    if (len - pos < guard) guard = len - pos;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    let r;
    if (r = tokSpace(lx, src, pos)) {
      pos = r.next;
      const lastSp = tokens[tokens.length - 1];
      if (r.tok.raw.length === 1 && lastSp !== undefined) lastSp.raw += '\n';
      else tokens.push(r.tok);
      continue;
    }
    if (r = tokCode(lx, src, pos)) {
      pos = r.next;
      const lastCd = tokens[tokens.length - 1];
      if (lastCd && (lastCd.type === 'paragraph' || lastCd.type === 'text')) {
        lastCd.raw += (lastCd.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        lastCd.text += '\n' + r.tok.text;
        lx.inlineQueue[lx.inlineQueue.length - 1].src = lastCd.text;
      } else tokens.push(r.tok);
      continue;
    }
    if (r = tokFences(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokHeading(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokHr(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokBlockquote(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokList(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokHtml(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokDef(lx, src, pos)) {
      pos = r.next;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.raw;
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
      } else {
        if (!Object.hasOwn(lx.links, r.tok.tag)) {
          lx.links[r.tok.tag] = { href: r.tok.href, title: r.tok.title };
          lx.linksCount++;
        }
        tokens.push(r.tok);
      }
      continue;
    }
    if (r = tokTable(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (r = tokLheading(lx, src, pos)) { pos = r.next; tokens.push(r.tok); continue; }
    if (lx.state.top && (r = tokParagraph(lx, src, pos))) {
      pos = r.next;
      const last = tokens[tokens.length - 1];
      if (mergePara && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.text;
        lx.inlineQueue.pop();
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
      } else {
        tokens.push(r.tok);
      }
      mergePara = false;
      continue;
    }
    if (r = tokText(lx, src, pos)) {
      pos = r.next;
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + r.tok.raw;
        last.text += '\n' + r.tok.text;
        lx.inlineQueue.pop();
        lx.inlineQueue[lx.inlineQueue.length - 1].src = last.text;
      } else {
        tokens.push(r.tok);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  lx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer. Produces exactly the HTML strings marked 18.1.3 produces.
// ---------------------------------------------------------------------------

const renderer = {
  space() { return ''; },
  code({ text, lang, escaped }) {
    const langPart = (lang || '').match(O.notSpaceStart)?.[0];
    const content = text ? text.replace(O.endingNewline, '') + '\n' : '';
    const body = escaped ? content : escHtml(content, true);
    return langPart
      ? `<pre><code class="language-${escHtml(langPart)}">${body}</code></pre>\n`
      : `<pre><code>${body}</code></pre>\n`;
  },
  blockquote({ tokens }) { return `<blockquote>\n${renderTokens(tokens)}</blockquote>\n`; },
  html({ text }) { return text; },
  def() { return ''; },
  heading({ tokens, depth }) { return `<h${depth}>${renderInline(tokens)}</h${depth}>\n`; },
  hr() { return '<hr>\n'; },
  list({ ordered, start, items }) {
    let s = '';
    for (const item of items) s += renderer.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr}>\n${s}</${tag}>\n`;
  },
  listitem(item) { return `<li>${renderTokens(item.tokens)}</li>\n`; },
  checkbox({ checked }) { return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; },
  paragraph({ tokens }) { return `<p>${renderInline(tokens)}</p>\n`; },
  table({ header, rows }) {
    let headCells = '';
    for (const cell of header) headCells += renderer.tablecell(cell);
    const head = renderer.tablerow({ text: headCells });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (const cell of row) cells += renderer.tablecell(cell);
      body += renderer.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  },
  tablerow({ text }) { return `<tr>\n${text}</tr>\n`; },
  tablecell(cell) {
    const content = renderInline(cell.tokens);
    const tag = cell.header ? 'th' : 'td';
    return cell.align
      ? `<${tag} align="${cell.align}">${content}</${tag}>\n`
      : `<${tag}>${content}</${tag}>\n`;
  },
  strong({ tokens }) { return `<strong>${renderInline(tokens)}</strong>`; },
  em({ tokens }) { return `<em>${renderInline(tokens)}</em>`; },
  codespan({ text }) { return `<code>${escHtml(text, true)}</code>`; },
  br() { return '<br>'; },
  del({ tokens }) { return `<del>${renderInline(tokens)}</del>`; },
  link({ href, title, text, tokens, autolink }) {
    const content = autolink ? escHtml(text, true) : renderInline(tokens);
    const cleaned = cleanHref(href);
    if (cleaned === null) return content;
    let out = `<a href="${escHtml(cleaned, autolink)}"`;
    if (title) out += ` title="${escHtml(title)}"`;
    return out + `>${content}</a>`;
  },
  image({ href, title, text, tokens }) {
    const alt = tokens ? renderInlineText(tokens) : text;
    const cleaned = cleanHref(href);
    if (cleaned === null) return escHtml(alt);
    let out = `<img src="${escHtml(cleaned)}" alt="${escHtml(alt)}"`;
    if (title) out += ` title="${escHtml(title)}"`;
    return out + '>';
  },
  text(token) {
    if (token.tokens) return renderInline(token.tokens);
    if (token.escaped) return token.text;
    return escHtml(token.text);
  },
};

// Plain-text renderer, used for image alt text: inline markup collapses to
// its text, with no tags at all.
const textRenderer = {
  strong({ text, tokens }) { return tokens ? renderInlineText(tokens) : text; },
  em({ text, tokens }) { return tokens ? renderInlineText(tokens) : text; },
  codespan({ text }) { return text; },
  del({ text, tokens }) { return tokens ? renderInlineText(tokens) : text; },
  html({ text }) { return text; },
  text({ text }) { return text; },
  link({ text, tokens }) { return tokens ? renderInlineText(tokens) : text; },
  image({ text, tokens }) { return tokens ? renderInlineText(tokens) : text; },
  br() { return ''; },
  checkbox({ raw }) { return raw; },
};

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': out += renderer.space(tok); break;
      case 'hr': out += renderer.hr(tok); break;
      case 'heading': out += renderer.heading(tok); break;
      case 'code': out += renderer.code(tok); break;
      case 'table': out += renderer.table(tok); break;
      case 'blockquote': out += renderer.blockquote(tok); break;
      case 'list': out += renderer.list(tok); break;
      case 'checkbox': out += renderer.checkbox(tok); break;
      case 'html': out += renderer.html(tok); break;
      case 'def': out += renderer.def(tok); break;
      case 'paragraph': out += renderer.paragraph(tok); break;
      case 'text': out += renderer.text(tok); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += renderer.text(tok); break;
      case 'html': out += renderer.html(tok); break;
      case 'link': out += renderer.link(tok); break;
      case 'image': out += renderer.image(tok); break;
      case 'checkbox': out += renderer.checkbox(tok); break;
      case 'strong': out += renderer.strong(tok); break;
      case 'em': out += renderer.em(tok); break;
      case 'codespan': out += renderer.codespan(tok); break;
      case 'br': out += renderer.br(tok); break;
      case 'del': out += renderer.del(tok); break;
      case 'text': out += renderer.text(tok); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderInlineText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': out += textRenderer.strong(tok); break;
      case 'em': out += textRenderer.em(tok); break;
      case 'codespan': out += textRenderer.codespan(tok); break;
      case 'del': out += textRenderer.del(tok); break;
      case 'html': out += textRenderer.html(tok); break;
      case 'text': out += textRenderer.text(tok); break;
      case 'link': out += textRenderer.link(tok); break;
      case 'image': out += textRenderer.image(tok); break;
      case 'br': out += textRenderer.br(tok); break;
      case 'checkbox': out += textRenderer.checkbox(tok); break;
      case 'escape': out += textRenderer.text(tok); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

export function parse(markdown) {
  return renderTokens(new Lexer().lex(markdown));
}
