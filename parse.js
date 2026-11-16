// A fast, dependency-free Markdown renderer whose parse(markdown) returns exactly
// the HTML marked 18.1.3 renders with its defaults (gfm on, breaks off, pedantic
// off, async off). Written from scratch for the make.fun "Make Markdown rendering
// faster" bounty; it follows the same block/inline phases as any CommonMark+GFM
// renderer, but renders straight to strings (no token objects, no second pass)
// and scans inline text with a single manual pass instead of a regex per token.
//
// Layout: regex constants, small helpers, the inline renderer, the block lexer
// (which records a light tree of blocks), and the block renderer. Link reference
// definitions are collected during the block pass and only then is inline text
// rendered, so a definition anywhere in the document applies to links anywhere.

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// A rule source without its leading ^, for use inside a lookahead or a
// larger pattern (where ^ would only match at position 0, never at the
// current position).
const stripCaret = (src) => src.replace(/^\^/, '');

const R = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
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
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Block-level
  newline: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  listStart: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  // Inline-level
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  codeSpan: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink:
    /^<(scheme:[^\s\x00-\x1f<>]*|email)>/,
  // filled in below (needs scheme/email pieces)
  comment: /<!--(?:-?>|[\s\S]*?(?:-->|$))/,
  tag: null, // filled in below
  // link / reflink pieces
  // Nested [...] group (one level) used inside link labels (marked's Le).
  bracketsRe: /\[(?:\\[\s\S]|[^\[\]\\])*?\]/,
  linkLabelInner: /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  refLabel: /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/,
  link: null, // filled in below
  reflink: null,
  nolink: null,
  reflinkSearch: null,
  // emphasis delimiters
  emStrongLDelimAst: null,
  emStrongLDelimUnd: null,
  emStrongRDelimAst: null,
  emStrongRDelimUnd: null,
  delLDelim: null,
  delRDelim: null,
  punct: /[\p{P}\p{S}]/u,
  // marked's "punctuation" rule (nt): whitespace OR punctuation, but not
  // * or _. Used for the can-open/can-close checks in emStrong/del.
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  punctSpace: /[\s\p{P}\p{S}]/u,
  notPunctSpace: /[^\s\p{P}\p{S}]/u,
  punctNoTilde: /(?!~)[\p{P}\p{S}]/u,
  punctSpaceNoTilde: /(?!~)[\s\p{P}\p{S}]/u,
  notPunctSpaceTilde: /(?:[^\s\p{P}\p{S}]|~)/u,
  openQuote: /[\p{Pi}\p{Ps}"']/u,
  anyPunct: /\\(punct)/gu,
  anyPunctOutsideCode: null,
  blockSkip: null,
  url: null,
  text: null,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  email: /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  emailAt: /[a-zA-Z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
};

// --- Pieces that are built from other pieces (same construction as the
// reference renderer's grammar, written out here for clarity) ---

const SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
R.autolink = new RegExp(
  '^<(' + SCHEME.source + ':[^\\s\\x00-\\x1f<>]*|' + EMAIL_RE.source + ')>'
);
R.tag = new RegExp(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
    .replace('comment', R.comment.source)
    .replace(
      'attribute',
      "\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?"
    )
);

// link: !?[label](href "title")
// Build the label pattern with the nested-brackets group substituted in.
R.linkLabelInner = new RegExp(
  R.linkLabelInner.source.replace('brackets', R.bracketsRe.source)
);
R.link = new RegExp(
  '^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)'
    .replace('label', R.linkLabelInner.source)
    .replace('href', '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))')
    .replace('title', '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)')
);
R.reflink = new RegExp(
  '^!?\\[(label)\\]\\[(ref)\\]'
    .replace('label', R.linkLabelInner.source)
    .replace('ref', R.refLabel.source)
);
R.nolink = new RegExp(
  '^!?\\[(ref)\\](?:\\[\\])?'.replace('ref', R.refLabel.source)
);
// reflinkSearch: finds [label][ref] or [ref] anywhere (global, for masking)
{
  const brackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  const labelSearch =
    /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/.source.replace(
      'brackets',
      brackets.source
    );
  const refSearch = /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/.source.replace(
    'brackets',
    brackets.source
  );
  const reflinkRe = new RegExp(
    '^!?\\[(label)\\]\\[(ref)\\]'.replace('label', labelSearch).replace('ref', /(?:\\[\s\S]|[^\[\]\\]){1,999}/.source)
  );
  const nolinkRe = new RegExp(
    '^!?\\[(ref)\\](?:\\[\\])?'.replace('ref', /(?:\\[\s\S]|[^\[\]\\]){1,999}/.source)
  );
  R.reflinkSearch = new RegExp(
    'reflink|nolink(?!\\()'
      .replace('reflink', stripCaret(reflinkRe.source))
      .replace('nolink', stripCaret(nolinkRe.source)),
    'g'
  );
}

// Emphasis delimiter runs. `punct` here is the GFM flavour (tilde excluded
// from the "punctuation" used for _ and * runs in the GFM inline grammar).
function emLDelim(punctRe) {
  return new RegExp(
    '^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|^_+(?:((?!_)punct)|([^\\s_]))?'.replace(
      /punct/g,
      punctRe.source
    ),
    'u'
  );
}
function emRDelimAst(punctRe, notPunctSpaceRe, punctSpaceRe) {
  const s =
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
  return new RegExp(
    s
      .replace(/notPunctSpace/g, notPunctSpaceRe.source)
      .replace(/punctSpace/g, punctSpaceRe.source)
      .replace(/punct/g, punctRe.source),
    'gu'
  );
}
function emRDelimUnd(punctRe, notPunctSpaceRe, punctSpaceRe) {
  const s =
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
  return new RegExp(
    s
      .replace(/notPunctSpace/g, notPunctSpaceRe.source)
      .replace(/punctSpace/g, punctSpaceRe.source)
      .replace(/punct/g, punctRe.source),
    'gu'
  );
}
R.emStrongLDelimAst = emLDelim(R.punctNoTilde);
R.emStrongLDelimUnd = emLDelim(R.punctNoTilde);
R.emStrongRDelimAst = emRDelimAst(R.punctNoTilde, R.notPunctSpaceTilde, R.punctSpaceNoTilde);
R.emStrongRDelimUnd = emRDelimUnd(R.punct, R.notPunctSpace, R.punctSpace);
R.delLDelim = new RegExp(
  '^~~?(?:((?!~)punct)|[^\\s~])'.replace('punct', R.punct.source),
  'u'
);
{
  const s =
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
  R.delRDelim = new RegExp(
    s
      .replace(/notPunctSpace/g, R.notPunctSpace.source)
      .replace(/punctSpace/g, R.punctSpace.source)
      .replace(/punct/g, R.punct.source),
    'gu'
  );
}
// anyPunctuation / blockSkip / url / text (GFM inline)
R.anyPunct = new RegExp('\\\\(punct)'.replace('punct', R.punct.source), 'gu');
{
  const codePart = '(?<b>`+)[^`]+\\k<b>(?!`)';
  R.anyPunctOutsideCode = new RegExp(
    '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(punct)'
      .replace('punct', R.punct.source),
    'gu'
  );
  const linkPart =
    '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)';
  R.blockSkip = new RegExp(
    'link|precode-code|html'
      .replace('link', linkPart)
      .replace('precode-', '(?<!`)()')
      .replace('code', codePart)
      .replace('html', '<(?! )[^<>]*?>'),
    'g'
  );
  const emailProto =
    '(?:mailto:email|xmpp:email(?:\\/[A-Za-z0-9@.]+)?)'.replace(
      /email/g,
      R.email.source
    );
  R.url = new RegExp(
    '^emailProtocol|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^email'
      .replace('emailProtocol', emailProto)
      .replace('protocol', R.protocol.source)
      .replace('email', R.emailAt.source)
  );
  // GFM inline text: stops before emphasis/link/code/tag/br triggers, and
  // before extended autolinks (protocol://, www., email).
  R.text = new RegExp(
    '^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|protocol:\\/\\/|wwwStart|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))'
      .replace('protocol', R.protocol.source)
      .replace(/emailProtocol/g, '(?:mailto|xmpp):')
      .replace('wwwStart', '(?<![^\\s*_~(])www\\.'),
    ''
  );
}

// Block-level composite regexes (GFM).
const BULLET = /(?:[*+-]|\d{1,9}[.)])/;
const HR_BODY = /(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,}/;
const HR_RE = new RegExp(`^ {0,3}(${HR_BODY.source})(?:\\n+|$)`);
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCES_RE = / {0,3}(?:`{3,}|~{3,})/;
const BLOCKQUOTE_RE = / {0,3}>/;
const HTML_BEGIN_RE = new RegExp(
  `^ {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
  'i'
);
const TABLE_RE = new RegExp(
  `^ {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n`
);
// lheading (setext) for GFM: paragraph text, then = or - underline, but the
// text must not itself start a block.
const LHEADING_RE = (() => {
  const src =
    '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
  return new RegExp(
    src
      .replace(/bull/g, BULLET.source)
      .replace(/blockCode/g, '(?: {4}| {0,3}\\t)')
      .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
      .replace(/blockquote/g, ' {0,3}>')
      .replace(/heading/g, ' {0,3}#{1,6}(?:\\s|$)')
      .replace(/hr/g, ` {0,3}(?:${HR_BODY.source})(?:\\n+|$)`)
      .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
      .replace(/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n')
  );
})();
// paragraph (GFM): runs of lines that do not start a block.
const PARAGRAPH_RE = (() => {
  const src =
    '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
  const tableRe =
    '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
  return new RegExp(
    src
      .replace('hr', stripCaret(HR_RE.source))
      .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
      .replace('|lheading', '')
      .replace('table', stripCaret(tableRe))
      .replace('blockquote', ' {0,3}>')
      .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
      .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
      .replace(
        'html',
        ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`
      )
  );
})();
const TABLE_BLOCK_RE = new RegExp(
  tableReSrc()
    .replace('hr', stripCaret(HR_RE.source))
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace(
      'html',
      ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`
    )
    .replace('tag', BLOCK_TAGS)
);
function tableReSrc() {
  return '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
}
// blockquote body (GFM paragraph variant used inside blockquotes)
const BLOCKQUOTE_PARA_RE = (() => {
  const src =
    '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
  return new RegExp(
    src
      .replace('hr', stripCaret(HR_RE.source))
      .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
      .replace('|lheading', '')
      .replace('table', stripCaret(TABLE_RE.source))
      .replace('blockquote', ' {0,3}>')
      .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
      .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
      .replace(
        'html',
        ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`
      )
  );
})();
const BLOCKQUOTE_RE_FULL = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+'.replace(
    'paragraph',
    stripCaret(BLOCKQUOTE_PARA_RE.source)
  )
);
// link reference definition
const DEF_RE = (() => {
  const label = R.refLabel.source;
  const title = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/.source;
  return new RegExp(
    `^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)`
      .replace('label', label)
      .replace('title', title)
  );
})();
// HTML block (GFM): type 1-6 as in the spec.
const HTML_BLOCK_RE = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))'
    .replace('comment', R.comment.source)
    .replace('tag', BLOCK_TAGS)
    .replace(
      'attribute',
      " +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?"
    ),
  'i'
);

// --- Small helpers ----------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeChar(ch) {
  return ESCAPE_MAP[ch];
}
/** Escape &, <, >, ", ' (encode=true) or only <, >, ", ' plus bare & (encode=false). */
function escapeHtml(s, encode) {
  if (encode) {
    if (R.escapeTest.test(s)) return s.replace(R.escapeReplace, escapeChar);
  } else if (R.escapeTestNoEncode.test(s)) {
    return s.replace(R.escapeReplaceNoEncode, escapeChar);
  }
  return s;
}
/** Decode numeric character references and lone & to &amp; (marked's unescape). */
function unescapeEntities(s) {
  if (!R.numericCharacterReference.test(s)) return s;
  return s.replace(R.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}
function encodeHref(href) {
  try {
    return encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
}
/** Normalize a link label for reference lookup: collapse whitespace, case-fold. */
function normalizeLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
/** Index of the closing bracket matching the opener, skipping escapes. */
function findClosingBracket(src, brackets) {
  if (src.indexOf(brackets[0]) === -1 && src.indexOf(brackets[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === brackets[0]) level++;
    else if (src[i] === brackets[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}
/** Split a table row on unescaped pipes, trimming cells and dropping edges. */
function splitTableRow(row, count) {
  const parts = row.replace(R.findPipe, (m, off, s) => {
    let backslashes = false;
    let p = off;
    for (; --p >= 0 && s[p] === '\\';) backslashes = !backslashes;
    return backslashes ? '|' : ' |';
  }).split(R.splitPipe);
  let i = 0;
  if (!parts[0].trim()) parts.shift();
  if (parts.length > 0 && !parts[parts.length - 1]?.trim()) parts.pop();
  if (count) {
    if (parts.length > count) parts.splice(count);
    else for (; parts.length < count;) parts.push('');
  }
  for (; i < parts.length; i++) parts[i] = parts[i].trim().replace(R.slashPipe, '|');
  return parts;
}
/** Expand tabs to spaces to a 4-column tab stop, starting at column `col`. */
function expandTabs(s, col = 0) {
  let out = '';
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
/** Trim trailing blank lines, leaving at most one trailing newline (marked's rtrim). */
function rtrimBlankLines(s) {
  const lines = s.split('\n');
  let end = lines.length - 1;
  for (; end >= 0 && R.blankLine.test(lines[end]);) end--;
  return lines.length - end <= 2 ? s : lines.slice(0, end + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

// Sticky versions of the per-position inline tokenizers (lastIndex = position,
// no substring allocation).
/**
 * Sticky inline regexes. The block-level R.* patterns start with ^, which
 * never matches at a non-zero lastIndex even with the sticky flag, so the
 * ^ is stripped here (sticky already anchors the match to lastIndex).
 * Flags u/i are preserved; the g flag is dropped (sticky replaces it).
 */
function sticky(re) {
  let src = re.source;
  // Strip every anchor ^ (at the start, or after ( or |): with the sticky
  // flag ^ never matches at a non-zero lastIndex, and sticky already
  // anchors the match to lastIndex. A ^ inside [...] (negation) or after
  // a backslash (literal) is left alone.
  src = src.replace(/(^|[(|])\^/g, '$1');
  let flags = 'y';
  if (re.flags.includes('u')) flags += 'u';
  if (re.flags.includes('i')) flags += 'i';
  return new RegExp(src, flags);
}

const INLINE = {
  escape: sticky(R.escape),
  codeSpan: sticky(R.codeSpan),
  br: sticky(R.br),
  tag: sticky(R.tag),
  autolink: sticky(R.autolink),
  link: sticky(R.link),
  reflink: sticky(R.reflink),
  nolink: sticky(R.nolink),
  url: sticky(R.url),
  text: sticky(R.text),
  emLDelim: sticky(R.emStrongLDelimAst),
  delLDelim: sticky(R.delLDelim),
  punct: sticky(R.punct),
};

/** Scan a source for the last possible emphasis/strong/del closer positions. */
function findDelimClosers(src) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { em, del };
}

/** Does the text contain a link (used by the masking step). */
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  const linkRe = INLINE.link;
  for (const m of src.matchAll(R.blockSkip)) {
    linkRe.lastIndex = 0;
    if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  R.reflinkSearch.lastIndex = 0;
  for (const m of src.matchAll(R.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(s.slice(1, r - 1), links))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Mask a source for the emphasis/delimiter scan (marked's #n): link and code
 * spans become runs of 'a' so their * _ ~ do not count as delimiters, and
 * backslash-escaped punctuation becomes '+'.
 */
function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const re = R.reflinkSearch;
    const sub = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(re, sub) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(re, sub);
  }
  t = t.replace(R.anyPunctOutsideCode, (m, g1, g2) =>
    g2
      ? '+'.repeat(m.length)
      : g1
        ? g1 + m.slice(g1.length, -g1.length).replace(/`/g, '+') + g1
        : m
  );
  t = t.replace(R.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
}

// Inline render state, shared across the nested renders of one parse() call.
class InlineState {
  constructor(links) {
    this.links = links;
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.maskStack = [];
    // plain: render to plain text (no HTML tags), used for image alt text.
    this.plain = false;
  }
}

/** Render inline markdown to HTML, appending to `out`. */
function renderInline(src, st, out) {
  const masked = src.includes('*') || src.includes('_') || src.includes('~') ? maskSrc(src, st.links) : src;
  st.maskStack.push(findDelimClosers(masked));
  try {
    renderInlineInner(src, masked, st, out);
  } finally {
    st.maskStack.pop();
  }
}

function renderInlineInner(src, masked, st, out) {
  const n = src.length;
  let pos = 0;
  let prevChar = '';
  const links = st.links;
  while (pos < n) {
    const ch = src[pos];
    let consumed = 0;

    if (ch === '\\') {
      INLINE.escape.lastIndex = pos;
      let m = INLINE.escape.exec(src);
      if (m) {
        out.push(escapeHtml(m[1], false));
        pos += m[0].length;
        prevChar = m[0].slice(-1);
        continue;
      }
      INLINE.br.lastIndex = pos;
      m = INLINE.br.exec(src);
      if (m) {
        if (!st.plain) out.push('<br>');
        pos += m[0].length;
        prevChar = '';
        continue;
      }
    } else if (ch === '<') {
      INLINE.tag.lastIndex = pos;
      let m = INLINE.tag.exec(src);
      if (m) {
        if (!st.inLink && R.startATag.test(m[0])) st.inLink = true;
        else if (st.inLink && R.endATag.test(m[0])) st.inLink = false;
        if (!st.inRawBlock && R.startPreScriptTag.test(m[0])) st.inRawBlock = true;
        else if (st.inRawBlock && R.endPreScriptTag.test(m[0])) st.inRawBlock = false;
        out.push(m[0]);
        pos += m[0].length;
        prevChar = m[0].slice(-1);
        continue;
      }
      INLINE.autolink.lastIndex = pos;
      m = INLINE.autolink.exec(src);
      if (m) {
        let text, href;
        if (m[2] === '@') {
          text = m[1];
          href = 'mailto:' + text;
        } else {
          text = m[1];
          href = text;
        }
        if (st.plain) out.push(text);
        else out.push(linkHtml(href, null, escapeHtml(text, true), true, st));
        pos += m[0].length;
        prevChar = m[0].slice(-1);
        continue;
      }
    } else if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
      const r = tryLink(src, pos, st, out);
      if (r > 0) {
        pos += r;
        prevChar = src[pos - 1];
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      const r = tryEmStrong(src, masked, pos, prevChar, st, out);
      if (r > 0) {
        pos += r;
        prevChar = src[pos - 1];
        continue;
      }
    } else if (ch === '`') {
      INLINE.codeSpan.lastIndex = pos;
      const m = INLINE.codeSpan.exec(src);
      if (m) {
        let text = m[2].replace(R.newLineCharGlobal, ' ');
        const hasNonSpace = R.nonSpaceChar.test(text);
        const wrapped =
          R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
        if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
        if (st.plain) out.push(text);
        else out.push('<code>' + escapeHtml(text, true) + '</code>');
        pos += m[0].length;
        prevChar = m[0].slice(-1);
        continue;
      }
    } else if (ch === '~') {
      const r = tryDel(src, masked, pos, prevChar, st, out);
      if (r > 0) {
        pos += r;
        prevChar = src[pos - 1];
        continue;
      }
    } else if (ch === ' ') {
      INLINE.br.lastIndex = pos;
      const m = INLINE.br.exec(src);
      if (m) {
        out.push('<br>');
        pos += m[0].length;
        prevChar = '';
        continue;
      }
    } else if (!st.inLink && (ch === '.' || ch === '_' || ch === '+' || ch === '-' || (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))) {
      // Extended autolink (URL or bare email). Tried before the text run,
      // like marked, so an email is not split by the text tokenizer.
      // The url regex fails fast when there is no ://, www. or @ ahead.
      INLINE.url.lastIndex = pos;
      const m = INLINE.url.exec(src);
      if (m) {
        let text, href;
        if (m[2] === '@') {
          text = m[0];
          href = 'mailto:' + text;
        } else {
          let raw = m[0];
          do {
            const prev = raw;
            const b = R.backpedal.exec(raw);
            raw = b ? b[0] : '';
            if (raw === prev) break;
          } while (true);
          text = raw;
          href = m[1] === 'www.' ? 'http://' + raw : raw;
        }
        if (st.plain) out.push(text);
        else out.push(linkHtml(href, null, escapeHtml(text, true), true, st));
        pos += text.length;
        prevChar = text.slice(-1);
        continue;
      }
    }

    // Plain text run.
    INLINE.text.lastIndex = pos;
    const m = INLINE.text.exec(src);
    if (m) {
      const raw = m[0];
      if (st.inRawBlock) out.push(raw);
      else if (st.plain) out.push(unescapeEntities(raw));
      else out.push(escapeHtml(unescapeEntities(raw), false));
      pos += raw.length;
      prevChar = raw.slice(-1);
      continue;
    }
    // Should not happen; avoid an infinite loop.
    out.push(escapeHtml(src[pos], false));
    pos++;
    prevChar = src[pos - 1];
  }
}

/** Build an <a> (or bare text when the href cannot be encoded). */
function linkHtml(href, title, innerHtml, isAutolink, st) {
  const enc = encodeHref(href);
  if (enc === null) return innerHtml;
  const hrefEsc = escapeHtml(enc, isAutolink);
  let s = '<a href="' + hrefEsc + '"';
  if (title) s += ' title="' + escapeHtml(title, false) + '"';
  return s + '>' + innerHtml + '</a>';
}

/** Try an inline or reference link (or image) at `pos`; returns raw length or 0. */
function tryLink(src, pos, st, out) {
  if (st.linkParenPossible === false) return 0;
  const links = st.links;
  INLINE.link.lastIndex = pos;
  let m = INLINE.link.exec(src);
  if (m) {
    const bang = m[0].charAt(0) === '!';
    const labelStart = bang ? 2 : 1;
    if (hasHtmlBeforeEnd(src, m[1], labelStart, st)) return 0;
    let href = m[2].trim();
    if (R.startAngleBracket.test(href)) {
      if (!R.endAngleBracket.test(href)) return 0;
      // marked: L(s.slice(0,-1), "\\") then checks parity of the stripped tail
      const inner = href.slice(0, -1);
      let cut = inner.length;
      while (cut > 0 && inner.charAt(cut - 1) === '\\') cut--;
      if ((href.length - cut) % 2 === 0) return 0;
    } else {
      const close = findClosingBracket(m[2], '()');
      if (close === -2) return 0;
      if (close > -1) {
        const h = (bang ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, h).trim();
        m[3] = '';
        href = m[2];
      }
    }
    let tail = m[0].slice(0, -1);
    let cut = tail.length;
    while (cut > 0 && tail.charAt(cut - 1) === '\\') cut--;
    if ((m[0].length - cut) % 2 === 0) return 0;
    let title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
    href = href.replace(R.anyPunct, '$1');
    title = title.replace(R.anyPunct, '$1');
    return emitLink(m, href, title, bang, st, out);
  }
  // Reference link / shortcut link.
  INLINE.reflink.lastIndex = pos;
  m = INLINE.reflink.exec(src);
  if (!m) {
    INLINE.nolink.lastIndex = pos;
    m = INLINE.nolink.exec(src);
  }
  if (m) {
    const bang = m[0].charAt(0) === '!';
    const labelStart = bang ? 2 : 1;
    if (hasHtmlBeforeEnd(src, m[1], labelStart, st)) return 0;
    const ref = normalizeLabel(m[2] || m[1]);
    const def = links[ref];
    if (!def) {
      // Not a defined reference: emit just the leading char as text.
      const ch = src[pos];
      out.push(escapeHtml(ch, false));
      return 1;
    }
    return emitLink(m, def.href, def.title, bang, st, out);
  }
  return 0;
}

/** Render a link/image once href+title are known; returns raw length. */
function emitLink(m, href, title, isImage, st, out) {
  const labelRaw = m[1].replace(R.outputLinkReplace, '$1');
  if (isImage && !st.plain) {
    // Normal image: the alt text is the label rendered as plain text.
    const enc = encodeHref(href);
    if (enc === null) {
      out.push(escapeHtml(labelRaw, false));
      return m[0].length;
    }
    const altPlain = [];
    st.plain = true;
    renderInline(labelRaw, st, altPlain);
    st.plain = false;
    let s = '<img src="' + escapeHtml(enc, false) + '" alt="' + escapeHtml(altPlain.join(''), false) + '"';
    if (title) s += ' title="' + escapeHtml(title, false) + '"';
    out.push(s + '>');
    return m[0].length;
  }
  // A link (or an image inside a plain render): render the label with the
  // nested-link check — a link whose label contains a link is not created
  // (marked's De returns undefined), so the '[' stays literal text.
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = [];
  renderInline(labelRaw, st, inner);
  const emitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (emitted) return 0;
    st.linkEmitted = true;
  }
  if (st.plain) out.push(inner.join(''));
  else out.push(linkHtml(href, title || null, inner.join(''), false, st));
  return m[0].length;
}

/**
 * Whether the link label contains raw HTML that ends after the label
 * (marked's Be check): a link whose label holds an unclosed tag is not a link.
 */
function hasHtmlBeforeEnd(src, label, labelStart, st) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      INLINE.codeSpan.lastIndex = i;
      const c = INLINE.codeSpan.exec(label);
      if (c) { i += c[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(labelStart + i);
    INLINE.tag.lastIndex = 0;
    const t = INLINE.tag.exec(rest);
    const a = R.autolink.exec(rest);
    const hit = t || a;
    if (hit) {
      if (hit[0].length > label.length - i) return true;
      i += hit[0].length - 1;
    }
  }
  return false;
}

/** Try an emphasis/strong run at `pos`; returns raw length or 0. */
function tryEmStrong(src, masked, pos, prevChar, st, out) {
  INLINE.emLDelim.lastIndex = pos;
  const s = INLINE.emLDelim.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return 0;
  const delim = s[0][0];
  const sameAsPrev = prevChar === delim;
  // Walk back over a delimiter run that ends where this opener starts.
  let l = pos;
  while (l > 0 && masked[l - 1] === delim) l--;
  // The char before the run ("" when the run starts the string).
  const beforeRun = l === 0 ? '' : masked[l - 1];
  const h = beforeRun === '*' || beforeRun === '_' || !!R.punctuation.exec(beforeRun);
  let n = prevChar;
  if (l < pos) n = beforeRun;
  const u = l < pos ? h : !!R.punctuation.exec(n);
  if (s[4] && R.unicodeAlphaNumeric.test(n)) return 0;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const runLen = [...s[0]].length - 1;
    let m = runLen;
    let f = 0;
    const y = pos - l + runLen;
    const canSplit = !!beforeRun.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return 0;
    const closerRe = delim === '*' ? R.emStrongRDelimAst : R.emStrongRDelimUnd;
    const lastCloser = st.maskStack[st.maskStack.length - 1].em[delim];
    const q = pos + runLen;
    if (lastCloser < q) return 0;
    // Marked execs the closer regex on the masked source SLICED to start
    // after the opener, so the leading ^ in the regex anchors the
    // '**..._...**' skip alternative to the search start. Exec'ing on the
    // full string would let that alternative match mid-string and swallow
    // a real closer (doc-21).
    const hay = masked.slice(q);
    const searchEnd = lastCloser - q;
    closerRe.lastIndex = 0;
    let match;
    while ((match = closerRe.exec(hay)) !== null && !(match.index > searchEnd)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const b = [...g].length;
      if (match[3] || match[4]) { m += b; continue; }
      else if (match[5] || match[6] || canSplit) {
        if (sameAsPrev && (match[5] || match[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const take = Math.min(b, b + m + f);
      const delimLen = [...match[0]][0].length;
      const rawLen = runLen + match.index + delimLen + take;
      const raw = src.slice(pos, pos + rawLen);
      if (Math.min(runLen, take) % 2) {
        const inner = raw.slice(1, -1);
        if (!st.plain) out.push('<em>');
        renderInline(inner, st, out);
        if (!st.plain) out.push('</em>');
      } else {
        const inner = raw.slice(2, -2);
        if (!st.plain) out.push('<strong>');
        renderInline(inner, st, out);
        if (!st.plain) out.push('</strong>');
      }
      return rawLen;
    }
  }
  return 0;
}

/** Try a strikethrough run at `pos`; returns raw length or 0. */
function tryDel(src, masked, pos, prevChar, st, out) {
  INLINE.delLDelim.lastIndex = pos;
  const s = INLINE.delLDelim.exec(src);
  if (!s) return 0;
  if (!(s[1] || '') || !prevChar || R.punctuation.exec(prevChar)) {
    const runLen = [...s[0]].length - 1;
    let p = runLen;
    const lastCloser = st.maskStack[st.maskStack.length - 1].del;
    const q = pos + runLen;
    if (lastCloser < q) return 0;
    const searchEnd = lastCloser - q;
    R.delRDelim.lastIndex = 0;
    const hay = masked.slice(q);
    let match;
    while ((match = R.delRDelim.exec(hay)) !== null && !(match.index > searchEnd)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const len = [...g].length;
      if (len !== runLen) continue;
      if (match[3] || match[4]) { p += len; continue; }
      if (p - len > 0) { p -= len; continue; }
      const take = Math.min(len, len + p);
      const delimLen = [...match[0]][0].length;
      const rawLen = runLen + match.index + delimLen + take;
      const raw = src.slice(pos, pos + rawLen);
      const inner = raw.slice(runLen, -runLen);
      if (!st.plain) out.push('<del>');
      renderInline(inner, st, out);
      if (!st.plain) out.push('</del>');
      return rawLen;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Block lexing: splits the source into a light tree of block records and
// collects link reference definitions. Inline text is rendered later, once
// every definition is known.
// ---------------------------------------------------------------------------

/** Remove a fence's indent from fenced code lines (marked's Dt). */
function fenceIndentCompensation(raw, code) {
  const m = raw.match(R.indentCodeCompensation);
  if (m === null) return code;
  const indent = m[1];
  return code
    .split('\n')
    .map((line) => {
      const lead = line.match(R.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// Per-item list regexes depend only on maxLead = min(3, indent-1), so
// there are just four possible sets. Compiling six RegExps per list item
// was the single biggest hotspot (the docs are list-heavy); precompile
// them once at module load instead.
const LIST_RES = [0, 1, 2, 3].map((maxLead) => ({
  nextBull: new RegExp(`^ {0,${maxLead}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
  hrAt: new RegExp(`^ {0,${maxLead}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
  fencesAt: new RegExp(`^ {0,${maxLead}}(?:\`\`\`|~~~)`),
  headingAt: new RegExp(`^ {0,${maxLead}}#{1,6}(?:\\s|$)`),
  htmlAt: new RegExp(`^ {0,${maxLead}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  bqAt: new RegExp(`^ {0,${maxLead}}>`),
}));

class BlockLexer {
  constructor() {
    this.links = Object.create(null);
    this.top = true;
  }

  lex(src) {
    src = src.replace(R.carriageReturn, '\n');
    const records = [];
    this.blockTokens(src, records, false);
    return records;
  }

  blockTokens(src, out, inBlock) {
    let prevLen = Infinity;
    while (src) {
      if (src.length < prevLen) prevLen = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let m;
      // Blank lines. A lone newline joins the previous token instead
      // of becoming a space token (marked's space merge).
      m = R.newline.exec(src);
      if (m && m[0].length > 0) {
        src = src.substring(m[0].length);
        if (!(m[0].length === 1 && out.length > 0)) out.push({ t: 'space', raw: m[0] });
        continue;
      }
      // Indented code.
      m = R.indentedCode.exec(src);
      if (m) {
        const raw = rtrimBlankLines(m[0]);
        const text = raw.replace(R.codeRemoveIndent, '');
        src = src.substring(raw.length);
        const last = out[out.length - 1];
        if (last && (last.t === 'paragraph' || last.t === 'text')) {
          last.text += '\n' + text;
        } else {
          out.push({ t: 'code', text, lang: null });
        }
        continue;
      }
      // Fenced code.
      m = R.fences.exec(src);
      if (m) {
        src = src.substring(m[0].length);
        const lang = m[2] ? m[2].trim().replace(R.anyPunct, '$1') : m[2];
        const text = fenceIndentCompensation(m[0], m[3] || '');
        out.push({ t: 'code', text, lang });
        continue;
      }
      // ATX heading.
      m = R.heading.exec(src);
      if (m) {
        const rawLen = m[0].replace(/\n+$/, '').length;
        src = src.substring(rawLen);
        let text = m[2].trim();
        if (R.endingHash.test(text)) {
          const stripped = text.replace(/#+$/, '');
          if (!stripped || R.endingSpaceTabChar.test(stripped)) text = stripped.trim();
        }
        out.push({ t: 'heading', depth: m[1].length, text });
        continue;
      }
      // Thematic break.
      m = R.hr.exec(src);
      if (m) {
        src = src.substring(m[0].replace(/\n+$/, '').length);
        out.push({ t: 'hr' });
        continue;
      }
      // Block quote.
      const bq = this.blockquote(src);
      if (bq) {
        src = src.substring(bq.len);
        out.push(bq.rec);
        continue;
      }
      // List.
      const lst = this.list(src);
      if (lst) {
        src = src.substring(lst.len);
        out.push(lst.rec);
        continue;
      }
      // HTML block.
      m = HTML_BLOCK_RE.exec(src);
      if (m) {
        const raw = rtrimBlankLines(m[0]);
        src = src.substring(raw.length);
        out.push({
          t: 'html',
          text: raw,
          pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        });
        continue;
      }
      // Link reference definition.
      m = DEF_RE.exec(src);
      if (m) {
        if (!R.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) {
          // Not a definition (unbalanced parens in the destination).
        } else {
          const rawLen = m[0].replace(/\n+$/, '').length;
          src = src.substring(rawLen);
          const last = out[out.length - 1];
          if (last && (last.t === 'paragraph' || last.t === 'text')) {
            last.text += '\n' + m[0].replace(/\n+$/, '');
          } else {
            const tag = normalizeLabel(m[1]);
            if (!this.links[tag]) {
              const href = m[2]
                ? m[2].replace(R.hrefBrackets, '$1').replace(R.anyPunct, '$1')
                : '';
              const title = m[3]
                ? m[3].substring(1, m[3].length - 1).replace(R.anyPunct, '$1')
                : m[3];
              this.links[tag] = { href, title };
            }
          }
          continue;
        }
      }
      // Table.
      const tbl = this.table(src);
      if (tbl) {
        src = src.substring(tbl.len);
        out.push(tbl.rec);
        continue;
      }
      // Setext heading.
      m = LHEADING_RE.exec(src);
      if (m) {
        src = src.substring(m[0].replace(/\n+$/, '').length);
        out.push({
          t: 'heading',
          depth: m[2].charAt(0) === '=' ? 1 : 2,
          text: m[1].trim(),
        });
        continue;
      }
      // Paragraph (only at the top level of a block run).
      if (this.top) {
        m = PARAGRAPH_RE.exec(src);
        if (m) {
          const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
          src = src.substring(m[0].length);
          const last = out[out.length - 1];
          if (inBlock && last && last.t === 'paragraph') {
            last.text += '\n' + text;
          } else {
            out.push({ t: 'paragraph', text });
          }
          continue;
        }
      }
      // Plain text (a single line, used inside lists and block quotes).
      m = /^[^\n]+/.exec(src);
      if (m) {
        src = src.substring(m[0].length);
        const last = out[out.length - 1];
        if (last && last.t === 'text') {
          last.text += '\n' + m[0];
        } else {
          out.push({ t: 'text', text: m[0] });
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.top = true;
    return out;
  }

  blockquote(src) {
    const m = BLOCKQUOTE_RE_FULL.exec(src);
    if (!m) return null;
    const rawLines = m[0].replace(/\n$/, '').split('\n');
    let rawAcc = '';
    let textAcc = '';
    const items = [];
    let lines = rawLines;
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (R.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          inQuote = true;
        } else if (!inQuote) {
          chunk.push(lines[p]);
        } else break;
      }
      lines = lines.slice(p);
      const chunkSrc = chunk.join('\n');
      const unmarked = chunkSrc
        .replace(R.blockquoteMarkerWhitespace, (all, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
      rawAcc = rawAcc ? rawAcc + '\n' + chunkSrc : chunkSrc;
      textAcc = textAcc ? textAcc + '\n' + unmarked : unmarked;
      const savedTop = this.top;
      this.top = true;
      this.blockTokens(unmarked, items, true);
      this.top = savedTop;
      if (lines.length === 0) break;
      const last = items[items.length - 1];
      if (last && (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table')) break;
      if (last && last.t === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const combined = inner.rawSrc + '\n' + rest.replace(R.blockquoteSetextReplace2, '');
        const reparsed = this.blockquote(combined);
        items[items.length - 1] = reparsed.rec;
        const consumed = combined.substring(reparsed.rec.rawSrc.length).replace(/^\n/, '');
        const consumedLines = consumed ? consumed.split('\n').length : 0;
        const restLines = consumedLines > 0 ? lines.slice(0, -consumedLines) : lines;
        if (restLines.length > 0) rawAcc += '\n' + restLines.join('\n');
        textAcc = textAcc.substring(0, textAcc.length - inner.textSrc.length) + reparsed.rec.textSrc;
        lines = lines.slice(restLines.length);
        if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last && last.t === 'list') {
        const inner = last;
        const combined = inner.rawSrc + '\n' + lines.join('\n');
        const reparsed = this.list(combined);
        items[items.length - 1] = reparsed.rec;
        const extra = reparsed.rec.rawSrc.length > inner.rawSrc.length
          ? combined.slice(inner.rawSrc.length + 1, reparsed.rec.rawSrc.length).split('\n').length
          : 0;
        if (extra > 0) {
          const extraLines = lines.slice(0, extra).join('\n');
          rawAcc += '\n' + extraLines;
          textAcc += '\n' + extraLines;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    const rec = { t: 'blockquote', items, rawSrc: rawAcc, textSrc: textAcc };
    return { rec, len: rawAcc.length };
  }

  list(src) {
    const m0 = R.listStart.exec(src);
    if (!m0) return null;
    const whole = src;
    let e = src;
    const pos = () => whole.length - e.length;
    const bull = m0[1].trim();
    const ordered = bull.length > 1;
    const rec = {
      t: 'list',
      ordered,
      start: ordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bullPat = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRe = new RegExp(`^( {0,3}${bullPat})((?:[ \t][^\\n]*)?(?:\\n|$))`);
    let pendingLoose = false;
    for (; e;) {
      let blankItem = false;
      let content = '';
      const t = itemRe.exec(e);
      if (!t || R.hr.test(e)) break;
      const itemStart = pos();
      e = e.substring(t[0].length);
      const firstLine = t[2].split('\n', 1)[0];
      const bullLen = t[1].length;
      const mText = firstLine.includes('\t') ? firstLine.replace(R.leadingSpaceTab, (ws) => expandTabs(ws, bullLen)) : firstLine;
      const nextLine = e.split('\n', 1)[0];
      const emptyFirst = !mText.trim();
      let indent;
      let parts = null;
      if (emptyFirst && R.blankLine.test(nextLine)) {
        e = e.substring(nextLine.length + 1);
        blankItem = true;
      }
      if (!blankItem) {
        if (emptyFirst) {
          indent = bullLen + 1;
          parts = [''];
        } else {
          indent = mText.search(R.nonSpaceChar);
          indent = indent > 4 ? 1 : indent;
          parts = [mText.slice(indent)];
          indent += bullLen;
        }
        const maxLead = Math.min(3, indent - 1);
        const { nextBull, hrAt, fencesAt, headingAt, htmlAt, bqAt } = LIST_RES[maxLead];
        let cur = mText;
        let empty = emptyFirst;
        for (; e;) {
          const line = e.split('\n', 1)[0];
          let check = line.includes('\t') ? line.replace(R.leadingSpaceTab, (ws) => expandTabs(ws)) : line;
          if (
            fencesAt.test(line) || headingAt.test(line) || htmlAt.test(line) ||
            bqAt.test(line) || nextBull.test(line) || hrAt.test(line)
          ) break;
          if (check.search(R.nonSpaceChar) >= indent || !line.trim()) {
            parts.push(check.slice(indent));
          } else {
            if (
              empty || cur.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >= 4 ||
              fencesAt.test(cur) || headingAt.test(cur) || htmlAt.test(cur) || hrAt.test(cur)
            ) break;
            const isSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && LHEADING_RE.test(cur + '\n' + line);
            parts.push(isSetext ? '    ' + check.replace(/^ {0,3}/, '') : line);
          }
          empty = !line.trim();
          e = e.substring(line.length + 1);
          cur = check.slice(indent);
        }
      }
      const itemRaw = whole.slice(itemStart, pos());
      if (!rec.loose) {
        if (pendingLoose) rec.loose = true;
        else if (R.doubleBlankLine.test(itemRaw)) pendingLoose = true;
      }
      rec.items.push({ text: parts ? parts.join('\n') : content, task: false, checked: false, loose: false, raw: itemRaw, tokens: [] });
    }
    const lastItem = rec.items[rec.items.length - 1];
    if (!lastItem) return null;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    rec.rawSrc = whole.slice(0, pos()).trimEnd();
    for (const item of rec.items) {
      this.top = false;
      item.tokens = this.blockTokens(item.text, []);
      this.top = true;
      if (!rec.loose) {
        const spaces = item.tokens.filter((r) => r.t === 'space');
        if (spaces.length > 0 && spaces.some((r) => R.anyLine.test(r.raw))) rec.loose = true;
      }
    }
    for (const item of rec.items) {
      const first = item.tokens[0];
      item.task = R.listIsTask.test(item.text);
      if (item.task && first && (first.t === 'text' || first.t === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        first.text = first.text.replace(R.listReplaceTask, '');
        const cb = R.listTaskCheckbox.exec(item.raw);
        if (cb) item.checked = cb[0] !== '[ ]';
      } else if (item.task) {
        item.task = false;
      }
    }
    if (rec.loose) {
      for (const item of rec.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.t === 'text') tok.t = 'paragraph';
      }
    }
    return { rec, len: rec.rawSrc.length };
  }

  table(src) {
    const m = TABLE_BLOCK_RE.exec(src);
    if (!m || !R.tableDelimiter.test(m[2])) return null;
    const headerCells = splitTableRow(m[1]);
    const aligns = m[2].replace(R.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim()
      ? m[3].replace(R.tableRowBlankLine, '').split('\n')
      : [];
    const rec = { t: 'table', header: [], align: [], rows: [] };
    if (headerCells.length !== aligns.length) return null;
    for (const a of aligns) {
      if (R.tableAlignRight.test(a)) rec.align.push('right');
      else if (R.tableAlignCenter.test(a)) rec.align.push('center');
      else if (R.tableAlignLeft.test(a)) rec.align.push('left');
      else rec.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      rec.header.push({ text: headerCells[i], align: rec.align[i] });
    }
    for (const line of bodyLines) {
      rec.rows.push(
        splitTableRow(line, rec.header.length).map((cell, i) => ({
          text: cell,
          align: rec.align[i],
        }))
      );
    }
    return { rec, len: m[0].replace(/\n+$/, '').length };
  }
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(records, st, out) {
  for (const rec of records) {
    switch (rec.t) {
      case 'space':
        break;
      case 'code': {
        const lang = (rec.lang || '').match(R.notSpaceStart)?.[0];
        const text = rec.text ? rec.text.replace(R.endingNewline, '') + '\n' : '';
        out.push(
          lang
            ? '<pre><code class="language-' + escapeHtml(lang, false) + '">' + escapeHtml(text, true) + '</code></pre>\n'
            : '<pre><code>' + escapeHtml(text, true) + '</code></pre>\n'
        );
        break;
      }
      case 'heading': {
        out.push('<h' + rec.depth + '>');
        renderInline(rec.text, st, out);
        out.push('</h' + rec.depth + '>\n');
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'blockquote': {
        out.push('<blockquote>\n');
        renderBlocks(rec.items, st, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = rec.ordered ? 'ol' : 'ul';
        const startAttr = rec.ordered && rec.start !== 1 ? ' start="' + rec.start + '"' : '';
        out.push('<' + tag + startAttr + '>\n');
        for (const item of rec.items) {
          out.push('<li>');
          if (item.task && !rec.loose) {
            out.push(
              '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
            );
          }
          if (item.task && rec.loose) {
            renderBlocksWithCheckbox(item.tokens, st, out, item.checked);
          } else {
            renderBlocks(item.tokens, st, out);
          }
          out.push('</li>\n');
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'html':
        out.push(rec.text);
        break;
      case 'table': {
        let head = '';
        for (const cell of rec.header) {
          head += tableCell(cell, st, true);
        }
        let body = '';
        for (const row of rec.rows) {
          let cells = '';
          for (const cell of row) cells += tableCell(cell, st, false);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n');
        break;
      }
      case 'paragraph': {
        out.push('<p>');
        renderInline(rec.text, st, out);
        out.push('</p>\n');
        break;
      }
      case 'text': {
        renderInline(rec.text, st, out);
        break;
      }
    }
  }
}

function renderBlocksWithCheckbox(records, st, out, checked) {
  let done = false;
  for (const rec of records) {
    if (!done && (rec.t === 'paragraph' || rec.t === 'text')) {
      done = true;
      if (rec.t === 'paragraph') {
        out.push('<p>');
        out.push('<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
        renderInline(rec.text, st, out);
        out.push('</p>\n');
      } else {
        out.push('<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
        renderInline(rec.text, st, out);
      }
      continue;
    }
    renderBlocks([rec], st, out);
  }
}

function tableCell(cell, st, isHeader) {
  const inner = [];
  renderInline(cell.text, st, inner);
  const tag = isHeader ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner.join('') + `</${tag}>\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render markdown to exactly the HTML marked 18.1.3 renders with defaults. */
export function parse(markdown) {
  const lexer = new BlockLexer();
  const records = lexer.lex(markdown);
  const st = new InlineState(lexer.links);
  const out = [];
  renderBlocks(records, st, out);
  return out.join('');
}
