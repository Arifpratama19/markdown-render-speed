// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its default options (GFM on,
// breaks off, pedantic off, async off). Written from scratch against the
// CommonMark 0.31.2 and GFM 0.29 specifications, verified against marked's
// own output on the practice set. No caching across calls, no network, no
// file reads; the module is pure.
//
// Architecture: a block parser turns the source into blocks (headings,
// code, quotes, lists, tables, paragraphs, ...), and an inline parser
// renders the inline content of each block (emphasis, links, code spans,
// ...). Both levels are my own design, tuned to match marked's HTML.

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Tags the GFM "disallowed raw HTML" extension escapes when they appear inline.
const DISALLOWED = /^(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)$/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s, encodeAmp) {
  // encodeAmp: escape & too (for code and link text); otherwise only escape
  // a bare & (one not starting a valid entity/character reference).
  if (encodeAmp) {
    return s.replace(/[&<>"']/g, (c) => ESC[c]);
  }
  return s.replace(/[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC[c]);
}

function decodeEntities(s) {
  // Decode numeric character references; a lone & becomes &amp;.
  if (!s.includes('&')) return s;
  return s.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(code);
  });
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Collapse whitespace and case-fold a link label for reference lookup.
// Unicode case folding maps ß and ẞ to ss.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

function isBlank(s) {
  return /^[ \t]*$/.test(s);
}

// Expand tabs to spaces to a 4-column stop, starting at column `col`.
function expandTabs(s, col) {
  let out = '';
  col = col || 0;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Find the index of the closing bracket matching the opener at `openIdx`
// (which must be '[' or '('), skipping backslash escapes, code spans and
// <...> sequences (a `]` inside a code span or a tag does not close the
// link text). Returns -1 if there is no match.
function findClose(src, openIdx, open, close) {
  let level = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') {
      // Skip a code span: from this backtick run to the matching run.
      let n = 0;
      while (src[i + n] === '`') n++;
      const run = '`'.repeat(n);
      const end = src.indexOf(run, i + n);
      if (end === -1) return -1;
      i = end + n - 1;
      continue;
    }
    if (ch === '<') {
      // Skip an autolink / tag: to the next > (no newline inside).
      const end = src.indexOf('>', i + 1);
      const nl = src.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl)) {
        i = end;
        continue;
      }
    }
    if (ch === open) level++;
    else if (ch === close) {
      level--;
      if (level === 0) return i;
    }
  }
  return -1;
}

const INLINE_RE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/,
  codeSpan: /^(`+)([\s\S]*?[^`])\1(?!`)|^(`+)([\s\S]*?)\3(?!`)/,
  br: /^ {2,}\n(?!\s*$)/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/,
  autolinkEmail: /^<((?:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*))>/,
  tag: /^<!--(?:>|->|(?:(?!-->)[\s\S])*-->)|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<\?[\s\S]*?\?>|^<![A-Za-z][\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[(?:[^\[\]\\]|\\[\s\S]|\[(?:[^\[\]\\]|\\[\s\S])*\])*\]\(\s*(?:<([^<>\n]*?)>|([^<>\s()]*))?\s*(?:("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n])*'|\((?:\\[\s\S]|[^()\\])*\)))?\s*\)/,
  reflink: /^!?\[(?:[^\[\]\\]|\\[\s\S]|\[(?:[^\[\]\\]|\\[\s\S])*\])*\]\s*\[([^\[\]\n]*)\]/,
  nolink: /^!?\[[^\[\]\n]*\]/,
  url: /^(?:https?:\/\/[^\s<]+|www\.[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:[^\s<]*)?|[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<]+|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)/,
  text: /^[^\\`<*_~\[!&<\s]+/,
};


// ---------------------------------------------------------------------------
// Inline parser — delimiter stack (CommonMark emphasis algorithm)
// ---------------------------------------------------------------------------

// A delimiter run of * or _ in the source.
function delimInfo(src, pos, ch) {
  let n = 0;
  while (src[pos + n] === ch) n++;
  const before = pos === 0 ? '\n' : src[pos - 1];
  const after = pos + n >= src.length ? '\n' : src[pos + n];
  const beforeWs = /\s/.test(before);
  const afterWs = /\s/.test(after);
  const beforePunct = !beforeWs && /[\p{P}\p{S}]/u.test(before);
  const afterPunct = !afterWs && /[\p{P}\p{S}]/u.test(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  let canOpen, canClose;
  if (ch === '*' || ch === '~') {
    canOpen = leftFlanking;
    canClose = rightFlanking;
  } else {
    canOpen = leftFlanking && (!rightFlanking || beforePunct);
    canClose = rightFlanking && (!leftFlanking || afterPunct);
  }
  return { ch, n, canOpen, canClose };
}


// Match a code span starting at `pos` (which must be a backtick).
// Returns {text, len} or null. The opening run is maximal; the closing
// run must have exactly the same length.
function matchCodeSpan(src, pos) {
  let n = 0;
  while (src[pos + n] === '`') n++;
  const run = '`'.repeat(n);
  let i = pos + n;
  while (i < src.length) {
    const j = src.indexOf(run, i);
    if (j === -1) return null;
    if (src[j + n] === '`') { i = j + 1; continue; }
    if (j > pos + n && src[j - 1] === '`') { i = j + 1; continue; }
    return { text: src.slice(pos + n, j), len: j + n - pos };
  }
  return null;
}

// Split inline markdown into nodes and resolve emphasis / strikethrough.
// Returns the node list. Used both for top-level inline content and for
// link text (which is parsed recursively).
function inlineNodes(src, links) {
  // First pass: split into nodes. Delimiter runs become 'delim' nodes;
  // everything else becomes text/code/link/html nodes.
  const nodes = [];
  let pos = 0;
  const n = src.length;
  while (pos < n) {
    const ch = src[pos];
    // Backslash escape or hard break.
    if (ch === '\\') {
      const m = INLINE_RE.escape.exec(src.slice(pos));
      if (m) {
        nodes.push({ t: 'text', s: m[1] });
        pos += m[0].length;
        continue;
      }
      if (src[pos + 1] === '\n') {
        nodes.push({ t: 'br' });
        pos += 2;
        while (src[pos] === ' ' || src[pos] === '\t') pos++;
        continue;
      }
      nodes.push({ t: 'text', s: '\\' });
      pos++;
      continue;
    }
    // Code span: an opening run of N backticks, content, and a
    // closing run of exactly N backticks (not part of a longer run).
    if (ch === '`') {
      const m = matchCodeSpan(src, pos);
      if (m) {
        let text = m.text.replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) {
          text = text.slice(1, -1);
        }
        nodes.push({ t: 'code', s: text });
        pos += m.len;
        continue;
      }
      let rn = 0;
      while (src[pos + rn] === '`') rn++;
      nodes.push({ t: 'text', s: '`'.repeat(rn) });
      pos += rn;
      continue;
    }
    // Autolink <...> or raw HTML tag.
    if (ch === '<') {
      let m = INLINE_RE.autolink.exec(src.slice(pos));
      if (m) {
        nodes.push({ t: 'autolink', href: m[1], text: m[1] });
        pos += m[0].length;
        continue;
      }
      m = INLINE_RE.autolinkEmail.exec(src.slice(pos));
      if (m) {
        nodes.push({ t: 'autolink', href: 'mailto:' + m[1], text: m[1] });
        pos += m[0].length;
        continue;
      }
      m = INLINE_RE.tag.exec(src.slice(pos));
      if (m) {
        nodes.push({ t: 'html', s: m[0] });
        pos += m[0].length;
        continue;
      }
      nodes.push({ t: 'text', s: '<' });
      pos++;
      continue;
    }
    // Link or image.
    if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const r = tryLink(src, pos, links, nodes);
      if (r > 0) {
        pos += r;
        continue;
      }
      nodes.push({ t: 'text', s: ch });
      pos++;
      continue;
    }
    // Emphasis delimiter.
    if (ch === '*' || ch === '_') {
      const d = delimInfo(src, pos, ch);
      nodes.push({ t: 'delim', ch, n: d.n, canOpen: d.canOpen, canClose: d.canClose });
      pos += d.n;
      continue;
    }
    // Strikethrough delimiter (GFM): a run of 1-2 tildes. A run of
    // 3+ tildes is literal text. Flanking follows the * rules.
    if (ch === '~') {
      let m = 0;
      while (src[pos + m] === '~') m++;
      if (m <= 2) {
        const d = delimInfo(src, pos, '~');
        nodes.push({ t: 'delim', ch: '~', n: m, canOpen: d.canOpen, canClose: d.canClose });
        pos += m;
      } else {
        nodes.push({ t: 'text', s: '~'.repeat(m) });
        pos += m;
      }
      continue;
    }
    // Hard break: two or more spaces before a newline. The leading
    // whitespace of the next line is stripped.
    if (ch === ' ' && src[pos + 1] === ' ' && src.slice(pos).match(/^ {2,}\n(?!\s*$)/)) {
      const m = /^ {2,}\n/.exec(src.slice(pos));
      nodes.push({ t: 'br' });
      pos += m[0].length;
      while (src[pos] === ' ' || src[pos] === '\t') pos++;
      continue;
    }
    // GFM extended autolink (www. or email), only when not inside a link.
    if (/[A-Za-z0-9._+\-@]/.test(ch)) {
      const m = INLINE_RE.url.exec(src.slice(pos));
      if (m) {
        let raw = m[0];
        // Reject an email whose domain is followed by a character that
        // would extend it (e.g. hello@mail+xyz, a.b-c_d@a.b-, a.b-c_d@a.b_):
        // the whole match is invalid, not just the trailing character.
        // A trailing dot is sentence punctuation, not an extender.
        const afterRaw = src[pos + raw.length];
        const isBareEmail = raw.includes('@') && !/^https?:\/\//.test(raw) && !raw.startsWith('www.') && !/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(raw);
        const isSchemeEmail = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s]*@/.test(raw);
        // A scheme URL whose content starts with a backslash is not a
        // URL (e.g. "removes:\" is literal text).
        const schemeBackslash = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:\\/.test(raw);
        if (schemeBackslash) {
          // Fall through to plain text.
        } else if (isSchemeEmail && /[-_]$/.test(raw)) {
          // Fall through to plain text.
        } else if (!((isBareEmail || isSchemeEmail) && afterRaw !== undefined && /[A-Za-z0-9_+\-~]/.test(afterRaw))) {
          // Backpedal trailing punctuation (marked's backpedal).
          let text = raw;
          // A trailing &...; that looks like an entity ends the URL.
          if (/&[A-Za-z]+;$/.test(text)) text = text.slice(0, text.search(/&[A-Za-z]+;$/));
          // Trim trailing punctuation that is not balanced.
          let trimmed = text;
          while (/[?!.,:;*_~]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
          // Balance parentheses.
          let open = 0;
          for (const c of trimmed) {
            if (c === '(') open++;
            else if (c === ')') open--;
          }
          while (open < 0 && trimmed.endsWith(')')) {
            trimmed = trimmed.slice(0, -1);
            open++;
          }
          if (trimmed.length > 0) text = trimmed;
          // For a scheme email (mailto:, xmpp:), a trailing slash is not
          // part of the address, and only the first path segment belongs
          // to the URL (xmpp:foo@bar.baz/txt/bin -> .../txt).
          if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s]*@/.test(text)) {
            if (text.endsWith('/')) text = text.slice(0, -1);
            const slashIdx = text.indexOf('/', text.indexOf(':') + 1);
            if (slashIdx !== -1) {
              const second = text.indexOf('/', slashIdx + 1);
              if (second !== -1) text = text.slice(0, second);
            }
          }
          // A scheme URL must still have its colon and at least one
          // character after it once trailing punctuation is removed
          // (e.g. "Warning:**" is not a URL, it is just the word).
          if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(raw) && !/^[A-Za-z][A-Za-z0-9+.-]{1,31}:.+/.test(text)) {
            // Not a URL: fall through to plain text.
          } else {
          const isEmail = text.includes('@') && !text.startsWith('www.') && !/^https?:\/\//.test(text) && !/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(text);
          const href = isEmail ? 'mailto:' + text : (text.startsWith('www.') ? 'http://' + text : text);
          nodes.push({ t: 'autolink', href, text });
          pos += text.length;
          continue;
          }
        }
      }
    }
    // Plain text run. Stop before a character that starts a token, and
    // before a GFM autolink (www., http(s)://, or an email) so the URL
    // check above gets a chance to run at the word start.
    let end = pos + 1;
    while (end < n && !'\\`<>[*_~!'.includes(src[end]) && !(src[end] === ' ' && src[end + 1] === ' ')) {
      if (isUrlStart(src, end)) break;
      end++;
    }
    nodes.push({ t: 'text', s: src.slice(pos, end) });
    pos = end;
  }
  // Second pass: resolve emphasis / strikethrough with the delimiter stack.
  resolveEmphasis(nodes, links);
  return nodes;
}

// Render inline markdown to HTML. `links` is the map of reference
// definitions (label -> {href, title}). `plain` renders to plain text
// (used for image alt text).
function renderInline(src, links, plain) {
  return renderNodes(inlineNodes(src, links), links, plain);
}

// Are we currently inside a link (so GFM autolinks are suppressed)?
// Does a GFM autolink (www. URL, http(s) URL, scheme URL, or email)
// start at position `i` in `src`? Used to stop a plain-text run before
// it so the autolink check can run. The previous character must be a
// boundary (start, whitespace, or punctuation that cannot be part of
// the URL/email).
function isUrlStart(src, i) {
  if (i > 0) {
    const prev = src[i - 1];
    if (/[A-Za-z0-9]/.test(prev)) return false;
  }
  const rest = src.slice(i);
  if (rest.startsWith('www.')) return true;
  if (rest.startsWith('http://') || rest.startsWith('https://')) return true;
  // Scheme: letters/digits/+/-/. then a colon (mailto:, xmpp:, ...).
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(rest);
  if (scheme) return true;
  // Email: a local part followed by @ and a domain.
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]/.test(rest)) return true;
  return false;
}

function inLinkContext(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].t === 'link') return true;
    if (nodes[i].t === 'delim') continue;
  }
  return false;
}

// Resolve emphasis and strikethrough in the node list, in place, using the
// CommonMark delimiter stack algorithm.
function resolveEmphasis(nodes, links) {
  // CommonMark emphasis algorithm: walk the delimiter runs, keeping a
  // stack of openers. When a closer matches an opener, wrap the nodes
  // between them. A leftover closer is re-examined against earlier
  // openers, so `*foo **bar***` nests correctly.
  const stack = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t !== 'delim') { i++; continue; }
    if (node.canClose) {
      // Look for the nearest matching opener.
      let openerIdx = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        const o = nodes[stack[j]];
        if (o.ch !== node.ch) continue;
        // Rule of three: if either delimiter can both open and close
        // emphasis, and the sum of the remaining lengths is a multiple
        // of 3, they cannot match unless both lengths are multiples of 3.
        const eitherBoth = (o.canOpen && o.canClose) || (node.canOpen && node.canClose);
        if (eitherBoth && (o.n + node.n) % 3 === 0 && !(o.n % 3 === 0 && node.n % 3 === 0)) continue;
        openerIdx = stack[j];
        break;
      }
      if (openerIdx !== -1) {
        const opener = nodes[openerIdx];
        const use = opener.n >= 2 && node.n >= 2 ? 2 : 1;
        const kind = node.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const inner = nodes.slice(openerIdx + 1, i);
        const emNode = { t: kind, children: inner };
        opener.n -= use;
        node.n -= use;
        const replacement = [];
        if (opener.n > 0) replacement.push(opener);
        replacement.push(emNode);
        if (node.n > 0) replacement.push(node);
        nodes.splice(openerIdx, i - openerIdx + 1, ...replacement);
        // Rebuild the stack: keep openers before the match, and the
        // opener again if it has delimiters left.
        const newStack = [];
        for (const s of stack) {
          if (s < openerIdx) newStack.push(s);
        }
        if (opener.n > 0) newStack.push(openerIdx);
        stack.length = 0;
        stack.push(...newStack);
        // If the closer has delimiters left, re-examine it at its new
        // position (it may match another opener); otherwise move on.
        if (node.n > 0) {
          i = openerIdx + replacement.length - 1;
          continue;
        }
        i = openerIdx + replacement.length;
        continue;
      }
      if (node.canOpen) stack.push(i);
      i++;
      continue;
    }
    if (node.canOpen) stack.push(i);
    i++;
  }
}

// Render a node list to HTML.
function renderNodes(nodes, links, plain) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        out += plain ? decodeEntities(node.s) : escapeHtml(decodeEntities(node.s), false);
        break;
      case 'code':
        out += plain ? node.s : '<code>' + escapeHtml(node.s, true) + '</code>';
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'html': {
        if (plain) break;
        out += node.s;
        break;
      }
      case 'autolink': {
        if (plain) {
          out += node.text;
        } else {
          const enc = encodeHref(node.href);
          if (enc === null) out += escapeHtml(node.text, true);
          else out += '<a href="' + escapeHtml(enc, true) + '">' + escapeHtml(node.text, true) + '</a>';
        }
        break;
      }
      case 'link': {
        if (plain) {
          out += renderNodes(node.children, links, true);
        } else {
          const enc = encodeHref(node.href);
          const inner = renderNodes(node.children, links, false);
          if (enc === null) {
            out += inner;
          } else {
            let s = '<' + (node.img ? 'img src="' + escapeHtml(enc, false) + '" alt="' : 'a href="' + escapeHtml(enc, false) + '"');
            if (node.img) {
              s += renderNodes(node.children, links, true) + '"';
              if (node.title) s += ' title="' + escapeHtml(node.title, false) + '"';
              s += '>';
            } else {
              if (node.title) s += ' title="' + escapeHtml(node.title, false) + '"';
              s += '>' + inner + '</a>';
            }
            out += s;
          }
        }
        break;
      }
      case 'em':
        out += plain ? renderNodes(node.children, links, true) : '<em>' + renderNodes(node.children, links, false) + '</em>';
        break;
      case 'strong':
        out += plain ? renderNodes(node.children, links, true) : '<strong>' + renderNodes(node.children, links, false) + '</strong>';
        break;
      case 'del':
        out += plain ? renderNodes(node.children, links, true) : '<del>' + renderNodes(node.children, links, false) + '</del>';
        break;
      case 'delim':
        out += plain ? node.ch.repeat(node.n) : escapeHtml(node.ch.repeat(node.n), false);
        break;
    }
  }
  return out;
}


// Try to parse a link or image starting at `pos` (which is '[' or '![').
// On success, pushes a link node into `nodes` and returns the consumed
// length. On failure returns 0.
function tryLink(src, pos, links, nodes) {
  const isImage = src[pos] === '!';
  const start = isImage ? pos + 1 : pos;
  if (src[start] !== '[') return 0;
  // Find the matching ] for the link text, respecting nesting and escapes.
  const textEnd = findClose(src, start, '[', ']');
  if (textEnd === -1) return 0;
  const text = src.slice(start + 1, textEnd);
  let after = textEnd + 1;
  let href = null;
  let title = null;
  // Try an inline link first; if it fails, fall back to a reference link
  // (a shortcut like [foo] followed by text that is not a valid inline
  // destination still resolves against the definitions).
  if (src[after] === '(') {
    const inl = parseInlineDest(src, after);
    if (inl) {
      href = inl.href;
      title = inl.title;
      after = inl.after;
    }
  }
  if (href === null) {
    // Reference link: [text][label] or [text][] or [text] (shortcut).
    // The label ends at the first ] (it cannot contain an unescaped [).
    let label = null;
    let refAfter = after;
    if (src[refAfter] === '[') {
      let labelEnd = -1;
      for (let k = refAfter + 1; k < src.length; k++) {
        if (src[k] === '\\') { k++; continue; }
        if (src[k] === ']') { labelEnd = k; break; }
      }
      if (labelEnd === -1) return 0;
      label = src.slice(refAfter + 1, labelEnd);
      if (/(^|[^\\])\[/.test(label)) return 0;
      refAfter = labelEnd + 1;
      if (label === '') label = text;
    } else {
      label = text;
    }
    const key = normLabel(label);
    const def = links[key];
    if (!def) return 0;
    href = def.href;
    title = def.title;
    after = refAfter;
  }
  // Parse the link text as inline content (recursively). A link cannot
  // contain another link (an image may): if the text already holds a link,
  // this is not a link. Check recursively — the link may be nested inside
  // emphasis.
  const children = parseInlineNodes(text, links);
  if (!isImage && containsLink(children)) return 0;
  nodes.push({ t: 'link', href: decodeEntities(href), title: title === null ? null : decodeEntities(title), img: isImage, children });
  return after - pos;
}

// Parse an inline link destination starting at the '(' at `after`.
// Returns {href, title, after} or null. Only space/tab/newline separates
// the parts (a non-breaking space does not).
function parseInlineDest(src, after) {
  let p = after + 1;
  while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  let dest = null;
  if (src[p] === '<') {
    // Angle-bracket destination: to the next unescaped > (no newline).
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === '\n') break;
      if (src[q] === '>') { ok = true; break; }
      q++;
    }
    if (!ok) return null;
    dest = src.slice(p + 1, q);
    p = q + 1;
  } else {
    // Bare destination: balanced parens, ends at space/tab/newline or ).
    let q = p;
    let depth = 0;
    while (q < src.length) {
      const c = src[q];
      if (c === '\\') { q += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    dest = src.slice(p, q);
    p = q;
  }
  // Optional title, then the closing ).
  while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  let title = null;
  if (src[p] === '"' || src[p] === "'" || src[p] === '(') {
    const open = src[p];
    const closeCh = open === '(' ? ')' : open;
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === '\n' && open !== '"') break;
      if (src[q] === closeCh) { ok = true; break; }
      q++;
    }
    if (!ok) return null;
    title = src.slice(p + 1, q).replace(/\\(.)/g, '$1');
    p = q + 1;
    while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  }
  if (src[p] !== ')') return null;
  const href = dest.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  return { href, title, after: p + 1 };
}

// Does any node in this tree (at any depth) hold a link?
function containsLink(nodes) {
  for (const node of nodes) {
    if (node.t === 'link' && !node.img) return true;
    if (node.children && containsLink(node.children)) return true;
  }
  return false;
}

// Parse inline content into a node list (used for link text). This is the
// same first pass as renderInline, minus the final render.
function parseInlineNodes(src, links) {
  return inlineNodes(src, links);
}


// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Match a link reference definition at the start of `src`.
// Returns {href, title, len} or null. The label may span lines and must
// have balanced brackets; a later definition of the same label is ignored.
function matchDef(src, links) {
  if (!/^ {0,3}\[/.test(src)) return null;
  let labelEnd = -1;
  for (let k = src.indexOf('[') + 1; k < src.length; k++) {
    if (src[k] === '\\') { k++; continue; }
    if (src[k] === ']') { labelEnd = k; break; }
  }
  if (labelEnd === -1) return null;
  const label = src.slice(src.indexOf('[') + 1, labelEnd);
  if (label.trim() === '' || /(^|[^\\])\[/.test(label)) return null;
  let p = labelEnd + 1;
  if (src[p] !== ':') return null;
  p++;
  while (p < src.length && (src[p] === ' ' || src[p] === '\t')) p++;
  if (src[p] === '\n') {
    p++;
    while (p < src.length && (src[p] === ' ' || src[p] === '\t')) p++;
  }
  // Destination: <...> or a bare run of non-space characters.
  let href = null;
  if (src[p] === '<') {
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === '\n') break;
      if (src[q] === '>') { ok = true; break; }
      q++;
    }
    if (!ok) return null;
    href = src.slice(p + 1, q).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    p = q + 1;
  } else {
    let q = p;
    while (q < src.length && src[q] !== ' ' && src[q] !== '\t' && src[q] !== '\n') {
      if (src[q] === '\\') q++;
      q++;
    }
    if (q === p) return null;
    href = src.slice(p, q).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    p = q;
  }
  // Optional title on the same line or the next. A title must be
  // preceded by whitespace. If the title is malformed (or has trailing
  // text), the definition still stands with just the destination.
  const afterDest = p;
  let hadWs = false;
  while (p < src.length && (src[p] === ' ' || src[p] === '\t')) { p++; hadWs = true; }
  let title = null;
  let titleOnNextLine = false;
  if (src[p] === '\n') {
    let q = p + 1;
    while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
    if (src[q] === '"' || src[q] === "'" || src[q] === '(') {
      hadWs = true;
      titleOnNextLine = true;
      p = q;
    }
  }
  if ((src[p] === '"' || src[p] === "'" || src[p] === '(') && hadWs) {
    const open = src[p];
    const closeCh = open === '(' ? ')' : open;
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      if (src[q] === '\\') { q += 2; continue; }
      // A parenthesised title cannot span lines; a quoted one can.
      if (src[q] === '\n' && open === '(') break;
      if (src[q] === closeCh) { ok = true; break; }
      q++;
    }
    if (ok) {
      const rawTitle = src.slice(p + 1, q);
      // A title cannot contain a blank line.
      if (/\n[ \t]*\n/.test(rawTitle)) ok = false;
      else {
        const candTitle = rawTitle.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        let r = q + 1;
        while (r < src.length && (src[r] === ' ' || src[r] === '\t')) r++;
        if (src[r] === '\n' || r >= src.length) {
          title = candTitle;
          p = r;
        }
      }
    }
  }
  // If no valid title was found: when the title was attempted on the
  // next line, the definition still stands with just the destination
  // (the title line belongs to a later block). When there is trailing
  // non-whitespace text on the destination line, the whole definition
  // is invalid. Otherwise it is a valid definition with no title.
  if (title === null) {
    if (titleOnNextLine) {
      let r = afterDest;
      while (r < src.length && src[r] !== '\n') r++;
      p = r;
    } else {
      const lineEnd = src.indexOf('\n', afterDest);
      const restOfLine = src.slice(afterDest, lineEnd === -1 ? src.length : lineEnd);
      if (restOfLine.trim() !== '') return null;
      p = lineEnd === -1 ? src.length : lineEnd;
    }
  }
  while (p < src.length && (src[p] === ' ' || src[p] === '\t')) p++;
  // The definition ends at a newline (or the end of the source).
  let len;
  if (src[p] === '\n') len = p + 1;
  else if (p >= src.length) len = p;
  else return null;
  const key = normLabel(label);
  if (links[key]) return { len, dup: true };
  return { href, title, len, key };
}

// Split the source into block tokens. `links` collects reference definitions.
function tokenizeBlocks(src, links) {
  const blocks = [];
  let rest = src;
  while (rest.length > 0) {
    // Blank lines.
    let m = /^[ \t]*(?:\n|$)+/.exec(rest);
    if (m) {
      blocks.push({ t: 'space' });
      rest = rest.slice(m[0].length);
      continue;
    }
    // Link reference definition.
    const def = matchDef(rest, links);
    if (def) {
      if (!def.dup) links[def.key] = { href: def.href, title: def.title };
      rest = rest.slice(def.len);
      continue;
    }
    // Indented code block (4 spaces or a tab), not in a list context.
    m = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/.exec(rest);
    if (m) {
      let text = m[0].split('\n').map((line) => {
        if (/^[ \t]*$/.test(line)) {
          // A blank line: only spaces beyond a 4-space indent are content.
          const sp = line.replace(/\t/g, '    ');
          return sp.length >= 4 ? sp.slice(4) : '';
        }
        return line.replace(/^(?: {4}| {0,3}\t)/, '');
      }).join('\n').replace(/(\n[ \t]*)+$/, '\n');
      if (!text.endsWith('\n')) text += '\n';
      blocks.push({ t: 'icode', text });
      rest = rest.slice(m[0].length);
      continue;
    }
    // Fenced code block: opening fence, then lines until a matching
    // closing fence (same character, at least as long) or the end.
    m = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(rest);
    if (m) {
      const fence = m[1];
      const fenceChar = fence[0];
      const info = m[2].trim();
      // The fence may be indented up to 3 spaces; content lines lose
      // up to that many leading spaces.
      const fenceIndent = m[0].length - m[0].replace(/^ */, '').length;
      const bodyLines = [];
      let consumed = m[0].length;
      let restLines = rest.slice(consumed);
      // If the fence is backtick, the info string must not contain backticks.
      if (fenceChar === '`' && info.includes('`')) {
        // Not a fence; fall through to paragraph handling.
      } else {
        const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}[ \\t]*(?:\\n|$)`);
        let closed = false;
        while (restLines.length > 0) {
          const nl = restLines.indexOf('\n');
          const line = nl === -1 ? restLines : restLines.slice(0, nl);
          if (closeRe.test(line)) {
            consumed += line.length + 1;
            closed = true;
            break;
          }
          bodyLines.push(line.replace(new RegExp(`^ {0,${fenceIndent}}`), ''));
          consumed += line.length + 1;
          restLines = nl === -1 ? '' : restLines.slice(nl + 1);
        }
        let body = bodyLines.join('\n');
        if (body !== '' && bodyLines[bodyLines.length - 1] !== '') body += '\n';
        blocks.push({ t: 'code', text: body, lang: info });
        rest = rest.slice(consumed);
        continue;
      }
    }
    // ATX heading.
    m = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/.exec(rest);
    if (m) {
      let text = m[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
      blocks.push({ t: 'heading', level: m[1].length, text });
      rest = rest.slice(m[0].length);
      continue;
    }
    // Thematic break.
    m = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/.exec(rest);
    if (m) {
      blocks.push({ t: 'hr' });
      rest = rest.slice(m[0].length);
      continue;
    }
    // Blockquote.
    if (/^ {0,3}>/.test(rest)) {
      const lines = [];
      let consumed = 0;
      const srcLines = rest.split('\n');
      let i = 0;
      while (i < srcLines.length) {
        const line = srcLines[i];
        const qm = /^ {0,3}> ?(.*)$/.exec(line);
        if (qm) {
          lines.push(qm[1]);
          consumed += line.length + 1;
          i++;
        } else if (isBlank(line)) {
          // A truly blank line (no > marker) ends the blockquote.
          break;
        } else {
          // Lazy continuation: a non-blank line without a > marker can
          // only continue a paragraph. It is not lazy if it would start
          // a new block: a setext underline, a thematic break, a fenced
          // code fence, or a list marker at column 0. An indented list
          // marker (e.g. "    - bar") is a paragraph continuation.
          if (lines.length === 0) break;
          const prev = lines[lines.length - 1];
          if (isBlank(prev)) break;
          if (!endsWithParagraph(lines)) break;
          if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line)) break;
          if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) break;
          if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) break;
          if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) break;
          let lazy = line.replace(/^[ \t]+/, '');
          if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(lazy)) lazy = '\\' + lazy;
          // A lazy setext underline is paragraph text, not an underline:
          // indent it so it cannot be read as one.
          if (/^(=+|-+)[ \t]*$/.test(lazy)) lazy = '    ' + lazy;
          lines.push(lazy);
          consumed += line.length + 1;
          i++;
        }
      }
      const inner = lines.join('\n');
      blocks.push({ t: 'blockquote', blocks: tokenizeBlocks(inner, links) });
      rest = rest.slice(Math.min(consumed, rest.length));
      continue;
    }
    // List.
    m = /^( {0,3})([*+-]|\d{1,9}[.)])(?:[ \t]+|\n|$)/.exec(rest);
    if (m) {
      const list = parseList(rest, links);
      blocks.push(list.block);
      rest = rest.slice(list.len);
      continue;
    }
    // HTML block.
    m = matchHtmlBlock(rest);
    if (m) {
      blocks.push({ t: 'html', text: m.text });
      rest = rest.slice(m.len);
      continue;
    }
    // Table (GFM): header line + delimiter line.
    m = matchTable(rest);
    if (m) {
      blocks.push(m.block);
      rest = rest.slice(m.len);
      continue;
    }
    // Setext heading (lheading): paragraph text followed by === or ---.
    // The heading text lines cannot themselves be setext underlines.
    m = /^([^\n]+(?:\n(?![ \t]*(?:\n|$))(?![ \t]*(?:=+|-+)[ \t]*(?:\n|$))[ \t]*[^ \n][^\n]*)*)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/.exec(rest);
    if (m && !/^ {0,3}(?:[*+-]|\d{1,9}[.)])/.test(m[1]) && !isTableHeader(m[1])) {
      blocks.push({ t: 'heading', level: m[2][0] === '=' ? 1 : 2, text: m[1].trim() });
      rest = rest.slice(m[0].length);
      continue;
    }
    // Paragraph: consume lines until a blank line or a block start.
    // Continuation lines may start with spaces (an indented code block
    // cannot interrupt a paragraph, so an indented line here is text).
    // A trailing line of only spaces at the very end of the input
    // (e.g. from a ">  " blockquote line) is kept as paragraph content.
    m = /^([^\n]+(?:\n(?![ \t]*(?:\n|$))[ \t]*[^ \n][^\n]*)*(?:\n[ \t]+$)?)/.exec(rest);
    if (!m) {
      // Fallback: consume one line to avoid an infinite loop.
      const nl = rest.indexOf('\n');
      const line = nl === -1 ? rest : rest.slice(0, nl);
      blocks.push({ t: 'paragraph', text: line });
      rest = nl === -1 ? '' : rest.slice(nl + 1);
      continue;
    }
    // A paragraph stops before a block that can interrupt it.
    let text = m[1];
    const lines = text.split('\n');
    let cut = lines.length;
    for (let i = 1; i < lines.length; i++) {
      if (interruptsParagraph(lines[i])) { cut = i; break; }
    }
    text = lines.slice(0, cut).join('\n');
    // Recompute consumed length.
    let consumed = text.length;
    if (cut < lines.length) {
      // The paragraph consumed only up to the interrupting line.
      consumed = lines.slice(0, cut).join('\n').length;
    }
    blocks.push({ t: 'paragraph', text });
    rest = rest.slice(consumed);
    // Skip the newline after the paragraph.
    if (rest.startsWith('\n')) rest = rest.slice(1);
  }
  return blocks;
}

function isTableHeader(line) {
  return line.includes('|');
}

// Does this line start a block that can interrupt a paragraph?
// An empty list item (a bare marker with nothing after it) cannot.
// An HTML block of type 7 (a non-block tag like <a>) cannot interrupt.
function interruptsParagraph(line) {
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]*$/.test(line)) return false;
  if (/^ {0,3}</.test(line) && !isHtmlBlock16Start(line)) return false;
  // An ordered list can only interrupt a paragraph if it starts with 1.
  if (/^ {0,3}[2-9]\d*[.)](?:[ \t]|$)/.test(line)) return false;
  if (/^ {0,3}1[.)](?:[ \t]|$)/.test(line)) return true;
  return /^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|>|[*+-](?:[ \t]|$)|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,}|<)/.test(line)
    || /^ {0,3}[*+-][ \t]/.test(line);
}

// Does this line start an HTML block of type 1-6 (one that can interrupt
// a paragraph)? Type 7 (any other tag) cannot.
function isHtmlBlock16Start(line) {
  const s = line.replace(/^ {0,3}/, '');
  if (/^<(script|pre|style|textarea)[\s>]|^<(script|pre|style|textarea)$/i.test(s)) return true;
  if (s.startsWith('<!--')) return true;
  if (s.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(s)) return true;
  if (s.startsWith('<![CDATA[')) return true;
  if (new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>|$)`).test(s)) return true;
  return false;
}



// Does the blockquote content in `lines` (already stripped of > markers)
// end with a paragraph? A lazy line may only continue a paragraph.
function endsWithParagraph(lines) {
  // If we are inside an unclosed fenced code block, a lazy line cannot
  // continue it (it ends the blockquote instead).
  let inFence = null;
  for (const l of lines) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fm) {
      if (inFence === null) inFence = fm[1][0];
      else if (fm[1][0] === inFence) inFence = null;
    }
  }
  if (inFence !== null) return false;
  // Find the last non-blank line.
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) { last = k; break; }
  }
  if (last === -1) return false;
  const line = lines[last];
  // A fence, heading, list item, thematic break, or indented code line
  // is not a paragraph.
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) return false;
  if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line)) return false;
  if (/^(?: {4}|\t)/.test(line)) return false;
  return true;
}

// Parse a list starting at the beginning of `src`. Returns {block, len}.
function parseList(src, links) {
  const first = /^( {0,3})([*+-]|\d{1,9}[.)])(?:[ \t]+|\n|$)/.exec(src);
  const ordered = /\d/.test(first[2][0]);
  const marker = first[2];
  const items = [];
  let rest = src;
  let loose = false;
  while (true) {
    // A thematic break ends the list (it is not a list item).
    if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*\n/.test(rest)) break;
    const m = new RegExp(`^( {0,3})(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|[*+-]|\\d{1,9}[.)])([ \\t]*\\n|[ \\t]+|$)`).exec(rest);
    if (!m) break;
    // Ordered lists must use the same delimiter; bullet lists the same char.
    if (ordered) {
      if (!/^\d{1,9}[.)]$/.test(m[2]) || m[2].slice(-1) !== marker.slice(-1)) break;
    } else if (m[2] !== marker) break;
    // Indent of the item content: the marker plus the spaces after it,
    // but if there are 5+ spaces (or a tab), the content starts after
    // one space and the rest belongs to the content.
    const afterMarker = rest.slice(m[0].length);
    const firstLine = afterMarker.split('\n')[0];
    const sep = m[3];
    const spacesLen = sep.replace(/\n$/, '').length;
    let indent;
    // Whether a blank line precedes the next item of this list.
    let blankBeforeNext = false;
    if (sep.endsWith('\n') || firstLine.trim() === '') {
      indent = m[1].length + m[2].length + 1;
    } else if (spacesLen >= 5) {
      indent = m[1].length + m[2].length + 1;
    } else {
      indent = m[1].length + m[2].length + spacesLen;
    }
    // Consume the item's lines.
    const itemLines = [];
    let consumed = m[0].length;
    let blankRun = 0;
    const lines = afterMarker.split('\n');
    let li = 0;
    // Whether a blank line has been seen inside this item (a lazy
    // continuation line is only allowed before any blank line).
    let sawBlank = false;
    // First line is already part of the item. If the marker was followed
    // by 5+ spaces, the extra spaces belong to the content (the indent is
    // marker+1). If the item was empty on this line, the content starts on
    // the next line and must be indented by the item indent; a blank line
    // or an unindented line after an empty marker leaves the item empty.
    let emptyItem = false;
    if (sep.endsWith('\n')) {
      if (isBlank(lines[0])) {
        emptyItem = true;
        li = lines.length;
      } else if (new RegExp(`^ {${indent},}`).test(lines[0]) || /^\t/.test(lines[0])) {
        itemLines.push(lines[0].replace(new RegExp(`^ {0,${indent}}`), ''));
        consumed += lines[0].length + 1;
        li = 1;
      } else {
        emptyItem = true;
        li = lines.length;
      }
    } else if (spacesLen >= 5) {
      itemLines.push(' '.repeat(spacesLen - 1) + lines[0]);
      consumed += lines[0].length + 1;
      li = 1;
    } else {
      itemLines.push(lines[0]);
      consumed += lines[0].length + 1;
      li = 1;
    }
    while (li < lines.length) {
      const line = lines[li];
      if (isBlank(line)) {
        // Blank: include it if the next non-blank line belongs to the item.
        let j = li + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j >= lines.length) break;
        const nxt = lines[j];
        const indented = new RegExp(`^ {${indent},}`).test(nxt) || /^\t/.test(nxt);
        const isNextItem = new RegExp(`^ {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)`).test(nxt);
        if (indented || isNextItem) {
          for (let k = li; k < j; k++) { itemLines.push(''); consumed += lines[k].length + 1; }
          sawBlank = true;
          if (isNextItem) blankBeforeNext = true;
          li = j;
          continue;
        }
        break;
      }
      // A line belonging to this item: indented by `indent`, or a lazy
      // continuation (a paragraph line with less indent).
      if (new RegExp(`^ {${indent},}`).test(line)) {
        itemLines.push(line.slice(indent));
        consumed += line.length + 1;
        li++;
        continue;
      }
      if (/^\t/.test(line) && indent <= 4) {
        itemLines.push(line.slice(1));
        consumed += line.length + 1;
        li++;
        continue;
      }
      // Next list item at the same level.
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(line)) break;
      // Lazy continuation line (part of a paragraph in the item).
      // Its leading whitespace is stripped. A setext underline or
      // thematic break is not a lazy line — it ends the item. A line
      // that looks like a list marker is escaped so it stays paragraph
      // text when the item is re-parsed.
      if (!sawBlank) {
        if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) break;
        if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line)) break;
        let lazy = line.replace(/^[ \t]+/, '');
        if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(lazy)) lazy = '\\' + lazy;
        itemLines.push(lazy);
        consumed += line.length + 1;
        li++;
        continue;
      }
      break;
    }
    const itemText = itemLines.join('\n');
    // Task list item: [ ] or [x] at the start.
    let task = null;
    let content = itemText;
    const tm = /^\[([ xX])\][ \t]+/.exec(itemText);
    if (tm) {
      task = tm[1] !== ' ';
      content = itemText.slice(tm[0].length);
    }
    const subBlocks = tokenizeBlocks(content, links);
    items.push({ blocks: subBlocks, task });
    if (blankBeforeNext) loose = true;
    rest = rest.slice(Math.min(consumed, rest.length));
    // Blank lines between items make the list loose; the list
    // continues after them if another item of the same type follows.
    // Only consume the blanks when another item follows, so a blank
    // line before a non-item becomes a space block for the caller.
    const afterBlanks = rest.replace(/^[ \t]*(?:\n|$)+/, '');
    if (afterBlanks !== rest) {
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(afterBlanks)) {
        loose = true;
        rest = afterBlanks;
      } else {
        break;
      }
    }
    if (rest.length === 0) break;
    if (!/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(rest)) break;
  }
  // A list is loose if any item contains a blank line between blocks.
  if (!loose) {
    for (const it of items) {
      const hasSpace = it.blocks.some((b) => b.t === 'space');
      if (hasSpace) { loose = true; break; }
    }
  }
  const start = ordered ? parseInt(marker, 10) : 1;
  return {
    block: { t: 'list', ordered, start, items, loose },
    len: src.length - rest.length,
  };
}

// Match an HTML block at the start of `src`. Returns {text, len} or null.
function matchHtmlBlock(src) {
  // Type 1: script, pre, style, textarea — ends at the closing tag.
  let m = /^ {0,3}<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)/i.exec(src);
  if (m) return { text: m[0], len: m[0].length };
  // Type 2: comment. The block ends at the end of the line containing -->.
  // An abruptly-closed comment (<!--> or <!--->) is also complete.
  m = /^ {0,3}<!--(?:>|->|(?:(?!-->)[\s\S])*-->)/.exec(src);
  if (m) {
    let end = m[0].length;
    const nlIdx = src.indexOf('\n', end);
    if (nlIdx === -1) {
      end = src.length;
    } else {
      // Include the line's newline, unless a blank line follows (then
      // the trailing newline is not part of the block).
      const after = src.slice(nlIdx + 1);
      if (/^[ \t]*(\n|$)/.test(after)) end = nlIdx;
      else end = nlIdx + 1;
    }
    return { text: src.slice(0, end), len: end };
  }
  // Type 3: processing instruction.
  m = /^ {0,3}<\?[\s\S]*?(?:\?>[^\n]*\n*|$)/.exec(src);
  if (m) return { text: m[0], len: m[0].length };
  // Type 4: declaration.
  m = /^ {0,3}<![A-Za-z][\s\S]*?(?:>[^\n]*\n*|$)/.exec(src);
  if (m) return { text: m[0], len: m[0].length };
  // Type 5: CDATA.
  m = /^ {0,3}<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)/.exec(src);
  if (m) return { text: m[0], len: m[0].length };
  // Type 6: block tag (open or close), ends at a blank line.
  m = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>|$)`).exec(src);
  if (m) {
    const end = htmlBlockEnd(src);
    return { text: src.slice(0, end), len: end };
  }
  // Type 7: any other tag (not a block tag), ends at a blank line.
  // Must not be a link/image/autolink start; must be a complete tag line.
  // Attributes are validated strictly: a name, an optional =value
  // (double-quoted, single-quoted, or unquoted), separated by whitespace.
  m = /^ {0,3}<[a-zA-Z][a-zA-Z0-9-]*(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^\n"]*"|'[^\n']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>(?=[ \t]*(?:\n|$))/.exec(src);
  if (m) {
    const end = htmlBlockEnd(src);
    return { text: src.slice(0, end), len: end };
  }
  m = /^ {0,3}<\/[a-zA-Z][a-zA-Z0-9-]*\s*>(?=[ \t]*(?:\n|$))/.exec(src);
  if (m) {
    const end = htmlBlockEnd(src);
    return { text: src.slice(0, end), len: end };
  }
  return null;
}

// An HTML block of type 6/7 ends at the first blank line. The trailing
// newline of the last line is not part of the block.
function htmlBlockEnd(src) {
  const idx = src.search(/\n[ \t]*\n/);
  if (idx === -1) return src.length;
  return idx;
}

// Match a GFM table at the start of `src`. Returns {block, len} or null.
function matchTable(src) {
  const lines = src.split('\n');
  if (lines.length < 2) return null;
  const header = lines[0];
  if (!header.includes('|')) return null;
  const delim = lines[1];
  const dm = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/.exec(delim);
  if (!dm) return null;
  // The delimiter must contain at least one pipe or be a valid row.
  const cells = splitRow(header);
  const aligns = dm[1].split('|').map((s) => s.trim()).filter((s) => s !== '').map((s) => {
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  if (aligns.length === 0) return null;
  // The delimiter must have the same number of cells as the header,
  // otherwise this is not a table at all.
  if (aligns.length !== cells.length) return null;
  // Consume body rows. A row need not contain a pipe; it is a single
  // cell (padded with empty cells to the header width).
  const rows = [];
  let consumed = lines[0].length + 1 + lines[1].length + 1;
  let i = 2;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) break;
    // A line starting a block (e.g. a blockquote) ends the table.
    if (/^ {0,3}>/.test(line)) break;
    rows.push(splitRow(line));
    consumed += line.length + 1;
    i++;
  }
  return {
    block: { t: 'table', header: cells, aligns, rows },
    len: consumed,
  };
}

// Split a table row on unescaped pipes, trimming cells and dropping edges.
function splitRow(row) {
  const parts = row.replace(/\\\|/g, '\u0000').split('|').map((p) => p.replace(/\u0000/g, '|').trim());
  if (parts.length > 0 && parts[0] === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}


// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, links) {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.t) {
      case 'space':
        break;
      case 'icode':
        out += '<pre><code>' + escapeHtml(b.text, true) + '</code></pre>\n';
        break;
      case 'code': {
        const langRaw = b.lang ? b.lang.split(/\s+/)[0].replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1') : '';
        const lang = langRaw ? ' class="language-' + escapeHtml(langRaw, false) + '"' : '';
        out += '<pre><code' + lang + '>' + escapeHtml(b.text, true) + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + b.level + '>' + renderInline(b.text, links, false) + '</h' + b.level + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote': {
        const inner = renderBlocks(b.blocks, links);
        out += '<blockquote>\n' + inner + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const item of b.items) {
          let inner = '';
          if (b.loose) {
            inner = renderBlocks(item.blocks, links);
          } else {
            // Tight list: render items without <p> wrappers.
            inner = renderTight(item.blocks, links);
          }
          // Task list checkbox. In a loose list the checkbox goes
          // inside the first paragraph; in a tight list it leads.
          if (item.task !== null) {
            const checked = item.task ? ' checked=""' : '';
            const box = '<input' + checked + ' disabled="" type="checkbox"> ';
            if (b.loose && inner.startsWith('<p>')) {
              inner = '<p>' + box + inner.slice(3);
            } else {
              inner = box + inner;
            }
          }
          out += '<li>' + inner + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'html':
        out += b.text;
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let j = 0; j < b.header.length; j++) {
          const align = b.aligns[j] ? ' align="' + b.aligns[j] + '"' : '';
          out += '<th' + align + '>' + renderInline(b.header[j], links, false) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let j = 0; j < b.header.length; j++) {
              const align = b.aligns[j] ? ' align="' + b.aligns[j] + '"' : '';
              const cell = row[j] !== undefined ? row[j] : '';
              out += '<td' + align + '>' + renderInline(cell, links, false) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'paragraph':
        out += '<p>' + renderInline(b.text, links, false) + '</p>\n';
        break;
    }
  }
  return out;
}

// Render a tight list item's blocks: paragraphs become bare inline content.
function renderTight(blocks, links) {
  let out = '';
  for (const b of blocks) {
    if (b.t === 'paragraph') {
      out += renderInline(b.text, links, false);
    } else if (b.t === 'space') {
      // Skip.
    } else {
      out += renderBlocks([b], links);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  let src = String(markdown).replace(/\r\n?/g, '\n');
  // Expand tabs in leading whitespace only (tab stops every 4
  // columns). Tabs inside content — notably in code — stay literal.
  // Lines inside a fenced code block are skipped: their tabs are content.
  // Fast path: most inputs have no tab at all.
  if (src.includes('\t')) {
  const lines = src.split('\n');
  let inFence = null;
  src = lines.map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (inFence === null) inFence = fence[1][0];
      else if (fence[1][0] === inFence) inFence = null;
    }
    if (inFence !== null) return line;
    const m = /^[ \t]*/.exec(line);
    if (!m || !m[0].includes('\t')) return line;
    // A line already indented by 4+ spaces is indented code: a tab
    // after that indent is content, not structure, so leave it alone.
    if (/^ {4,}/.test(m[0])) return line;
    let out = '';
    let col = 0;
    for (const ch of m[0]) {
      if (ch === '\t') {
        const n = 4 - (col % 4);
        out += ' '.repeat(n);
        col += n;
      } else {
        out += ch;
        col++;
      }
    }
    return out + line.slice(m[0].length);
  }).join('\n');
  }
  const links = Object.create(null);
  const blocks = tokenizeBlocks(src, links);
  return renderBlocks(blocks, links);
}

