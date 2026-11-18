const FORBIDDEN_IDENTIFIERS = new Set([
  'eval',
  'Function',
  'getBuiltinModule',
  'createRequire',
]);

const FORBIDDEN_STRING_VALUES = new Set([
  'child_process',
  'node:child_process',
  'vm',
  'node:vm',
  'worker_threads',
  'node:worker_threads',
  'module',
  'node:module',
  'eval',
  'Function',
  'getBuiltinModule',
  'createRequire',
]);

const CONDITION_HEADERS = new Set(['if', 'while', 'with']);

const EXPR_EXPECTED_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'default',
  'delete',
  'void',
  'typeof',
  'in',
  'instanceof',
  'new',
  'await',
  'yield',
  'else',
  'do',
]);

const EXPR_EXPECTED_PUNCT = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '?',
  '=',
  '=>',
  '...',
  '+',
  '-',
  '~',
  '!',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '>>>',
  '*',
  '/',
  '%',
  '**',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
]);

function isIdentStartChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  ) {
    return true;
  }
  return code >= 128 && /[\p{ID_Start}]/u.test(ch);
}

function isIdentPartChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36
  ) {
    return true;
  }
  return code >= 128 && /[\p{ID_Continue}\u200c\u200d]/u.test(ch);
}

function isHexDigit(ch) {
  return ch !== undefined && /^[0-9A-Fa-f]$/.test(ch);
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function readEscapeSequence(src, pos, label) {
  // pos points just after the backslash
  if (pos >= src.length) {
    throw new Error(`Unterminated escape sequence in ${label}`);
  }
  const ch = src[pos];
  if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
    return { value: '', next: pos + 1 };
  }
  if (ch === '\r') {
    return { value: '', next: src[pos + 1] === '\n' ? pos + 2 : pos + 1 };
  }
  switch (ch) {
    case 'n':
      return { value: '\n', next: pos + 1 };
    case 'r':
      return { value: '\r', next: pos + 1 };
    case 't':
      return { value: '\t', next: pos + 1 };
    case 'b':
      return { value: '\b', next: pos + 1 };
    case 'f':
      return { value: '\f', next: pos + 1 };
    case 'v':
      return { value: '\v', next: pos + 1 };
    case '0': {
      const nextCh = src[pos + 1];
      if (!isDigit(nextCh)) {
        return { value: '\0', next: pos + 1 };
      }
      break;
    }
    case 'x': {
      const hex = src.slice(pos + 1, pos + 3);
      if (hex.length !== 2 || !/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error(`Invalid hex escape in ${label}`);
      }
      return { value: String.fromCharCode(parseInt(hex, 16)), next: pos + 3 };
    }
    case 'u': {
      if (src[pos + 1] === '{') {
        const end = src.indexOf('}', pos + 2);
        if (end === -1) throw new Error(`Unterminated unicode escape in ${label}`);
        const hex = src.slice(pos + 2, end);
        if (!/^[0-9A-Fa-f]+$/.test(hex)) throw new Error(`Invalid unicode escape in ${label}`);
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) throw new Error(`Unicode escape out of range in ${label}`);
        return { value: String.fromCodePoint(cp), next: end + 1 };
      }
      const hex = src.slice(pos + 1, pos + 5);
      if (hex.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(hex)) {
        throw new Error(`Invalid unicode escape in ${label}`);
      }
      return { value: String.fromCharCode(parseInt(hex, 16)), next: pos + 5 };
    }
    default:
      break;
  }
  return { value: ch, next: pos + 1 };
}

function readStringLiteral(src, start, quote, label) {
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === quote) {
      return { value: out, next: i + 1 };
    }
    if (ch === '\\') {
      const esc = readEscapeSequence(src, i + 1, label);
      out += esc.value;
      i = esc.next;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      throw new Error(`Unterminated string literal in ${label}`);
    }
    out += ch;
    i++;
  }
  throw new Error(`Unterminated string literal in ${label}`);
}

function readTemplateChunk(src, start, label) {
  // start points just after ` or closing } of ${...}
  let out = '';
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      return { kind: 'end', value: out, next: i + 1 };
    }
    if (ch === '$' && src[i + 1] === '{') {
      return { kind: 'expr', value: out, next: i + 2 };
    }
    if (ch === '\\') {
      const esc = readEscapeSequence(src, i + 1, label);
      out += esc.value;
      i = esc.next;
      continue;
    }
    if (ch === '\r') {
      out += '\n';
      i += src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    out += ch;
    i++;
  }
  throw new Error(`Unterminated template literal in ${label}`);
}

function readRegexLiteral(src, start, label) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      if (i > src.length) throw new Error(`Unterminated regex literal in ${label}`);
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
      throw new Error(`Unterminated regex literal in ${label}`);
    }
    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      i++;
      continue;
    }
    if (ch === '/' && !inClass) {
      i++;
      while (i < src.length && isIdentPartChar(src[i])) i++;
      return i;
    }
    i++;
  }
  throw new Error(`Unterminated regex literal in ${label}`);
}

const MULTI_CHAR_OPS = [
  '>>>=',
  '===',
  '!==',
  '>>>',
  '**=',
  '<<=',
  '>>=',
  '&&=',
  '||=',
  '??=',
  '...',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '<<',
  '>>',
  '&&',
  '||',
  '??',
  '**',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
];

export function tokenizeEcmaModule(sourceText, label = '<module>') {
  if (typeof sourceText !== 'string') {
    throw new Error(`Expected string source for ${label}`);
  }
  let i = 0;
  if (sourceText.charCodeAt(0) === 0xfeff) i = 1;
  if (sourceText.startsWith('#!', i)) {
    const nl = sourceText.indexOf('\n', i);
    i = nl === -1 ? sourceText.length : nl + 1;
  }

  const tokens = [];
  const parenStack = [];
  const templateStack = [];
  const braceStack = [];
  const pendingBodyStack = [];
  const scopeTernaryStack = [0];
  let slashIsRegex = true;
  let atStatementStart = true;
  let asyncStartedAtStmt = false;
  let hadNewline = false;
  let bracketDepth = 0;

  function clearStalePendingBody() {
    while (
      pendingBodyStack.length > 0 &&
      pendingBodyStack[pendingBodyStack.length - 1].parenDepth === parenStack.length
    ) {
      pendingBodyStack.pop();
    }
  }

  function isAtForHeaderTopLevel(entry) {
    return (
      entry &&
      typeof entry === 'object' &&
      entry.kind === 'for' &&
      parenStack.length === entry.depth &&
      braceStack.length === entry.braceBase &&
      bracketDepth === entry.bracketBase
    );
  }

  function updateForHeaderState(tok, afterDot) {
    const entry = parenStack[parenStack.length - 1];
    if (!isAtForHeaderTopLevel(entry)) return false;

    if (tok.type === 'ident') {
      if (afterDot) {
        entry.lhsValidEnd = entry.canHaveOfSep;
        return false;
      }
      if (tok.value === 'of' && entry.canHaveOfSep && entry.lhsValidEnd) {
        entry.canHaveOfSep = false;
        entry.lhsValidEnd = false;
        return true;
      }
      if ((tok.value === 'var' || tok.value === 'let' || tok.value === 'const') && entry.canHaveOfSep && !entry.lhsValidEnd) {
        entry.lhsValidEnd = false;
        return false;
      }
      if (EXPR_EXPECTED_KEYWORDS.has(tok.value)) {
        entry.canHaveOfSep = false;
        entry.lhsValidEnd = false;
        return false;
      }
      if (entry.canHaveOfSep && !entry.lhsValidEnd) {
        entry.lhsValidEnd = true;
      } else {
        entry.canHaveOfSep = false;
        entry.lhsValidEnd = false;
      }
      return false;
    }

    if (tok.type === 'private_ident') {
      entry.lhsValidEnd = afterDot ? entry.canHaveOfSep : false;
      return false;
    }

    if (tok.type === 'punct') {
      if (tok.value === '.' || tok.value === '?.') {
        if (entry.lhsValidEnd) entry.lhsValidEnd = false;
        else entry.canHaveOfSep = false;
        return false;
      }
      if (tok.value === '[' || tok.value === '{' || tok.value === '(') {
        entry.lhsValidEnd = false;
        return false;
      }
      if (tok.value === ']' || tok.value === '}' || tok.value === ')') {
        if (entry.canHaveOfSep) entry.lhsValidEnd = true;
        return false;
      }
      entry.canHaveOfSep = false;
      entry.lhsValidEnd = false;
      return false;
    }

    entry.canHaveOfSep = false;
    entry.lhsValidEnd = false;
    return false;
  }

  function pushToken(tok) {
    const prev = tokens[tokens.length - 1];
    const prev2 = tokens[tokens.length - 2];
    tok.atStmtStart = atStatementStart;
    tok.hadNewlineBefore = hadNewline;
    hadNewline = false;

    const afterDot = prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.');
    const afterExportDefault =
      prev?.type === 'ident' &&
      prev.value === 'default' &&
      prev2?.type === 'ident' &&
      prev2.value === 'export';
    const afterExportDefaultAsync =
      prev?.type === 'ident' &&
      prev.value === 'async' &&
      prev2?.type === 'ident' &&
      prev2.value === 'default' &&
      tokens[tokens.length - 3]?.type === 'ident' &&
      tokens[tokens.length - 3].value === 'export';

    if (tok.type === 'ident' && !afterDot) {
      if (tok.value === 'async') {
        asyncStartedAtStmt = atStatementStart || afterExportDefault;
      } else if (tok.value === 'function') {
        const afterAsync = prev?.type === 'ident' && prev.value === 'async' && !tok.hadNewlineBefore;
        const isDecl = afterAsync
          ? asyncStartedAtStmt || afterExportDefaultAsync
          : atStatementStart || afterExportDefault;
        pendingBodyStack.push({
          parenDepth: parenStack.length,
          kind: isDecl ? 'block' : 'expr_body',
        });
      } else if (tok.value === 'class') {
        pendingBodyStack.push({
          parenDepth: parenStack.length,
          kind: atStatementStart || afterExportDefault ? 'class_decl' : 'class_expr',
        });
      }
    }

    tokens.push(tok);

    if (tok.type === 'ident') {
      const isForOfSep = updateForHeaderState(tok, afterDot);
      if (afterDot) {
        slashIsRegex = false;
        atStatementStart = false;
      } else {
        slashIsRegex = EXPR_EXPECTED_KEYWORDS.has(tok.value) || isForOfSep;
        if (tok.value === 'else' || tok.value === 'do' || tok.value === 'export') {
          atStatementStart = true;
        } else if (tok.value === 'async' && (prev?.type === 'ident' && (prev.value === 'export' || prev.value === 'default'))) {
          atStatementStart = asyncStartedAtStmt;
        } else {
          atStatementStart = false;
        }
      }
    } else if (tok.type === 'punct') {
      if (tok.value === ')') {
        if (scopeTernaryStack.length > 1) scopeTernaryStack.pop();
        const parenKind = parenStack.pop() ?? false;
        const isCondHeader = parenKind === 'cond' || parenKind?.kind === 'for';
        updateForHeaderState(tok, afterDot);
        slashIsRegex = isCondHeader;
        atStatementStart = isCondHeader;
      } else if (tok.value === ';') {
        clearStalePendingBody();
        updateForHeaderState(tok, afterDot);
        slashIsRegex = true;
        atStatementStart = true;
      } else if (tok.value === '[') {
        updateForHeaderState(tok, afterDot);
        bracketDepth++;
        slashIsRegex = true;
        atStatementStart = false;
      } else if (tok.value === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        updateForHeaderState(tok, afterDot);
        slashIsRegex = false;
        atStatementStart = false;
      } else if (tok.value === '{') {
        scopeTernaryStack.push(0);
        updateForHeaderState(tok, afterDot);
        let kind;
        if (
          pendingBodyStack.length > 0 &&
          pendingBodyStack[pendingBodyStack.length - 1].parenDepth === parenStack.length
        ) {
          kind = pendingBodyStack.pop().kind;
        } else if (prev?.type === 'punct' && (prev.value === '=>' || prev.value === ')')) {
          kind = 'block';
        } else if (
          !afterDot &&
          prev?.type === 'ident' &&
          (prev.value === 'try' ||
            prev.value === 'finally' ||
            prev.value === 'catch' ||
            prev.value === 'do' ||
            prev.value === 'else' ||
            prev.value === 'static')
        ) {
          kind = 'block';
        } else if (
          !afterDot &&
          prev?.type === 'ident' &&
          (prev.value === 'import' ||
            prev.value === 'export' ||
            (prev.value === 'type' && prev2?.type === 'ident' && prev2.value === 'export'))
        ) {
          kind = 'import_export';
        } else if (!atStatementStart) {
          kind = 'object';
        } else {
          kind = 'block';
        }
        braceStack.push(kind);
        slashIsRegex = true;
        atStatementStart = kind !== 'object' && kind !== 'import_export';
      } else if (tok.value === '}') {
        clearStalePendingBody();
        if (scopeTernaryStack.length > 1) scopeTernaryStack.pop();
        const closedKind = braceStack.pop() ?? 'block';
        updateForHeaderState(tok, afterDot);
        if (
          closedKind === 'object' ||
          closedKind === 'expr_body' ||
          closedKind === 'class_expr'
        ) {
          slashIsRegex = false;
          atStatementStart = false;
        } else {
          slashIsRegex = true;
          atStatementStart = true;
        }
      } else if (tok.value === '?') {
        updateForHeaderState(tok, afterDot);
        scopeTernaryStack[scopeTernaryStack.length - 1]++;
        slashIsRegex = true;
        atStatementStart = false;
      } else if (tok.value === ':') {
        clearStalePendingBody();
        updateForHeaderState(tok, afterDot);
        const topBrace = braceStack[braceStack.length - 1];
        if (topBrace === 'object') {
          slashIsRegex = true;
          atStatementStart = false;
        } else if (scopeTernaryStack[scopeTernaryStack.length - 1] > 0) {
          scopeTernaryStack[scopeTernaryStack.length - 1]--;
          slashIsRegex = true;
          atStatementStart = false;
        } else {
          slashIsRegex = true;
          atStatementStart = true;
        }
      } else if (tok.value === ',') {
        clearStalePendingBody();
        updateForHeaderState(tok, afterDot);
        slashIsRegex = true;
        atStatementStart = false;
      } else if (tok.value === '++' || tok.value === '--') {
        updateForHeaderState(tok, afterDot);
        slashIsRegex = false;
        atStatementStart = false;
      } else {
        updateForHeaderState(tok, afterDot);
        slashIsRegex = EXPR_EXPECTED_PUNCT.has(tok.value);
        atStatementStart = false;
      }
    } else if (tok.type === 'template_head') {
      updateForHeaderState(tok, afterDot);
      scopeTernaryStack.push(0);
      slashIsRegex = true;
      atStatementStart = false;
    } else if (tok.type === 'template_middle') {
      updateForHeaderState(tok, afterDot);
      scopeTernaryStack[scopeTernaryStack.length - 1] = 0;
      slashIsRegex = true;
      atStatementStart = false;
    } else if (tok.type === 'template_tail') {
      if (scopeTernaryStack.length > 1) scopeTernaryStack.pop();
      updateForHeaderState(tok, afterDot);
      slashIsRegex = false;
      atStatementStart = false;
    } else {
      updateForHeaderState(tok, afterDot);
      slashIsRegex = false;
      atStatementStart = false;
    }
  }

  function readIdentifierName(startIdx) {
    let name = '';
    let j = startIdx;
    while (j < sourceText.length) {
      if (sourceText[j] === '\\' && sourceText[j + 1] === 'u') {
        const esc = readEscapeSequence(sourceText, j + 1, label);
        name += esc.value;
        j = esc.next;
      } else if (isIdentPartChar(sourceText[j])) {
        name += sourceText[j];
        j++;
      } else {
        break;
      }
    }
    return { name, next: j };
  }

  while (i < sourceText.length) {
    const ch = sourceText[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || /\s/.test(ch)) {
      if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
        hadNewline = true;
      }
      i++;
      continue;
    }

    // Comments
    if (ch === '/' && sourceText[i + 1] === '/') {
      i += 2;
      while (i < sourceText.length && sourceText[i] !== '\n' && sourceText[i] !== '\r' && sourceText[i] !== '\u2028' && sourceText[i] !== '\u2029') {
        i++;
      }
      if (i < sourceText.length) hadNewline = true;
      continue;
    }
    if (ch === '/' && sourceText[i + 1] === '*') {
      const end = sourceText.indexOf('*/', i + 2);
      if (end === -1) {
        throw new Error(`Unterminated block comment in ${label}`);
      }
      if (/[\r\n\u2028\u2029]/.test(sourceText.slice(i + 2, end))) {
        hadNewline = true;
      }
      i = end + 2;
      continue;
    }

    // Template literal start
    if (ch === '`') {
      const chunk = readTemplateChunk(sourceText, i + 1, label);
      i = chunk.next;
      if (chunk.kind === 'end') {
        pushToken({ type: 'template_nosub', value: chunk.value });
      } else {
        templateStack.push({ braceDepth: 1 });
        pushToken({ type: 'template_head', value: chunk.value });
      }
      continue;
    }

    // Handle brace tracking inside active template ${...}
    if (templateStack.length > 0) {
      if (ch === '{') {
        templateStack[templateStack.length - 1].braceDepth++;
      } else if (ch === '}') {
        const top = templateStack[templateStack.length - 1];
        top.braceDepth--;
        if (top.braceDepth === 0) {
          templateStack.pop();
          const chunk = readTemplateChunk(sourceText, i + 1, label);
          i = chunk.next;
          if (chunk.kind === 'end') {
            pushToken({ type: 'template_tail', value: chunk.value });
          } else {
            templateStack.push({ braceDepth: 1 });
            pushToken({ type: 'template_middle', value: chunk.value });
          }
          continue;
        }
      }
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const str = readStringLiteral(sourceText, i, ch, label);
      i = str.next;
      pushToken({ type: 'string', value: str.value });
      continue;
    }

    // Regex literal vs '/'
    if (ch === '/' && slashIsRegex) {
      i = readRegexLiteral(sourceText, i, label);
      pushToken({ type: 'regex' });
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === '.' && isDigit(sourceText[i + 1]))) {
      let j = i;
      if (ch === '0' && (sourceText[j + 1] === 'x' || sourceText[j + 1] === 'X')) {
        j += 2;
        while (j < sourceText.length && (isHexDigit(sourceText[j]) || sourceText[j] === '_')) j++;
      } else if (ch === '0' && (sourceText[j + 1] === 'b' || sourceText[j + 1] === 'B')) {
        j += 2;
        while (j < sourceText.length && (sourceText[j] === '0' || sourceText[j] === '1' || sourceText[j] === '_')) j++;
      } else if (ch === '0' && (sourceText[j + 1] === 'o' || sourceText[j + 1] === 'O')) {
        j += 2;
        while (j < sourceText.length && ((sourceText[j] >= '0' && sourceText[j] <= '7') || sourceText[j] === '_')) j++;
      } else {
        while (j < sourceText.length && (isDigit(sourceText[j]) || sourceText[j] === '_')) j++;
        if (sourceText[j] === '.') {
          j++;
          while (j < sourceText.length && (isDigit(sourceText[j]) || sourceText[j] === '_')) j++;
        }
        if (sourceText[j] === 'e' || sourceText[j] === 'E') {
          j++;
          if (sourceText[j] === '+' || sourceText[j] === '-') j++;
          while (j < sourceText.length && (isDigit(sourceText[j]) || sourceText[j] === '_')) j++;
        }
      }
      if (sourceText[j] === 'n') j++;
      i = j;
      pushToken({ type: 'number' });
      continue;
    }

    // Private identifiers (#if, #eval, etc. — never keyword or condition header)
    if (ch === '#') {
      const nextCh = sourceText[i + 1];
      if (!isIdentStartChar(nextCh) && !(nextCh === '\\' && sourceText[i + 2] === 'u')) {
        throw new Error(`Invalid private identifier in ${label}`);
      }
      const { name, next } = readIdentifierName(i + 1);
      i = next;
      pushToken({ type: 'private_ident', value: `#${name}` });
      continue;
    }

    // Identifiers & keywords (including unicode \uXXXX escapes)
    if (isIdentStartChar(ch) || (ch === '\\' && sourceText[i + 1] === 'u')) {
      const { name, next } = readIdentifierName(i);
      i = next;
      pushToken({ type: 'ident', value: name });
      continue;
    }

    // Optional chaining ?. (when not followed by decimal digit)
    if (ch === '?' && sourceText[i + 1] === '.' && !isDigit(sourceText[i + 2])) {
      i += 2;
      pushToken({ type: 'punct', value: '?.' });
      continue;
    }

    // Multi-char operators
    let matchedOp = null;
    for (const op of MULTI_CHAR_OPS) {
      if (sourceText.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      i += matchedOp.length;
      pushToken({ type: 'punct', value: matchedOp });
      continue;
    }

    // Track paren headers so `if (cond) /regex/` works cleanly without matching `.if` / `#if`
    if (ch === '(') {
      const prev = tokens[tokens.length - 1];
      const prev2 = tokens[tokens.length - 2];
      const prevAfterDot = prev2?.type === 'punct' && (prev2.value === '.' || prev2.value === '?.');
      let parenEntry = false;
      if (!prevAfterDot && prev?.type === 'ident' && prev.atStmtStart) {
        if (prev.value === 'for') {
          parenEntry = {
            kind: 'for',
            depth: parenStack.length + 1,
            braceBase: braceStack.length,
            bracketBase: bracketDepth,
            canHaveOfSep: true,
            lhsValidEnd: false,
          };
        } else if (CONDITION_HEADERS.has(prev.value)) {
          parenEntry = 'cond';
        }
      } else if (
        prev?.type === 'ident' &&
        prev.value === 'await' &&
        prev2?.type === 'ident' &&
        prev2.value === 'for' &&
        prev2.atStmtStart
      ) {
        parenEntry = {
          kind: 'for',
          depth: parenStack.length + 1,
          braceBase: braceStack.length,
          bracketBase: bracketDepth,
          canHaveOfSep: true,
          lhsValidEnd: false,
        };
      }
      parenStack.push(parenEntry);
      scopeTernaryStack.push(0);
    }

    i++;
    pushToken({ type: 'punct', value: ch });
  }

  if (templateStack.length > 0) {
    throw new Error(`Unterminated template literal in ${label}`);
  }
  return tokens;
}

export function scanEcmaModule(sourceText, label = '<module>') {
  const tokens = tokenizeEcmaModule(sourceText, label);
  const staticSpecifiers = [];
  const dynamicSpecifiers = [];

  // Pass 1: unconditional security primitive check across every token (never skipped by statement advances)
  for (const tok of tokens) {
    if (tok.type === 'ident' && FORBIDDEN_IDENTIFIERS.has(tok.value)) {
      throw new Error(`Forbidden dynamic/process primitive (${tok.value}) in Pi package file: ${label}`);
    }
    if ((tok.type === 'string' || tok.type === 'template_nosub') && FORBIDDEN_STRING_VALUES.has(tok.value)) {
      throw new Error(`Forbidden dynamic/process primitive (${tok.value}) in Pi package file: ${label}`);
    }
  }

  // Pass 2: extract static & dynamic module specifiers with fail-closed dynamic import check
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    const isPropertyAccess = prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.');
    if (isPropertyAccess) continue;

    // Import declarations and dynamic import(...)
    if (tok.type === 'ident' && tok.value === 'import') {
      const next = tokens[i + 1];
      if (next?.type === 'punct' && (next.value === '.' || next.value === ':')) {
        // import.meta or `{ import: value }`
        continue;
      }
      if (next?.type === 'punct' && next.value === '(') {
        // Dynamic import(...): fail closed unless exact single string literal argument
        const argTok = tokens[i + 2];
        const closeTok = tokens[i + 3];
        if (
          argTok?.type !== 'string' ||
          closeTok?.type !== 'punct' ||
          closeTok.value !== ')'
        ) {
          throw new Error(`Non-literal dynamic import is forbidden in Pi package file: ${label}`);
        }
        dynamicSpecifiers.push(argTok.value);
        i += 3;
        continue;
      }
      if (next?.type === 'string') {
        staticSpecifiers.push(next.value);
        i += 1;
        continue;
      }
      if (
        next &&
        (next.type === 'ident' || (next.type === 'punct' && (next.value === '*' || next.value === '{')))
      ) {
        // Check static import clause -> `from "specifier"`
        let j = i + 1;
        let braceDepth = 0;
        let foundSpecifier = null;
        while (j < tokens.length) {
          const cur = tokens[j];
          if (cur.type === 'punct') {
            if (cur.value === '{') braceDepth++;
            else if (cur.value === '}') {
              braceDepth--;
              if (braceDepth < 0) break;
            } else if (cur.value === ';' && braceDepth === 0) {
              break;
            }
          } else if (braceDepth === 0 && cur.type === 'ident' && cur.value === 'from') {
            const after = tokens[j + 1];
            if (after?.type === 'string') {
              foundSpecifier = after.value;
              i = j + 1;
              break;
            }
            if (after?.type === 'ident' && after.value === 'from') {
              // Handle edge case: `import from from "./x.js"`
              j++;
              continue;
            }
            throw new Error(`Invalid import specifier in Pi package file: ${label}`);
          }
          j++;
        }
        if (foundSpecifier === null) {
          throw new Error(`Malformed static import in Pi package file: ${label}`);
        }
        staticSpecifiers.push(foundSpecifier);
        continue;
      }
    }

    // Export re-exports: `export * [as ns] from '...'` and `export { ... } from '...'`
    if (tok.type === 'ident' && tok.value === 'export') {
      let j = i + 1;
      if (tokens[j]?.type === 'punct' && tokens[j].value === ':') {
        continue;
      }
      if (tokens[j]?.type === 'punct' && tokens[j].value === '*') {
        j++;
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'as') {
          j += 2;
        }
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'from') {
          const specTok = tokens[j + 1];
          if (specTok?.type !== 'string') {
            throw new Error(`Invalid export specifier in Pi package file: ${label}`);
          }
          staticSpecifiers.push(specTok.value);
          i = j + 1;
          continue;
        }
        throw new Error(`Malformed export * declaration in Pi package file: ${label}`);
      }
      if (tokens[j]?.type === 'ident' && tokens[j].value === 'type') {
        j++;
      }
      if (tokens[j]?.type === 'punct' && tokens[j].value === '{') {
        let braceDepth = 1;
        j++;
        while (j < tokens.length && braceDepth > 0) {
          if (tokens[j].type === 'punct') {
            if (tokens[j].value === '{') braceDepth++;
            else if (tokens[j].value === '}') braceDepth--;
          }
          j++;
        }
        if (tokens[j]?.type === 'ident' && tokens[j].value === 'from') {
          const specTok = tokens[j + 1];
          if (specTok?.type !== 'string') {
            throw new Error(`Invalid export specifier in Pi package file: ${label}`);
          }
          staticSpecifiers.push(specTok.value);
          i = j + 1;
          continue;
        }
      }
    }
  }

  return { staticSpecifiers, dynamicSpecifiers };
}
