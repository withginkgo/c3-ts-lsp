import type { Position, Range } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

const C3_IDENTIFIER_PATTERN = '[A-Za-z_$@][A-Za-z0-9_$@]*';
const C3_QUALIFIED_IDENTIFIER_PATTERN = `${C3_IDENTIFIER_PATTERN}(?:::${C3_IDENTIFIER_PATTERN})*`;
const C3_PARTIAL_IDENTIFIER_PATTERN = `(?:${C3_IDENTIFIER_PATTERN})?`;

const EXPLICIT_TYPE_METHOD_DECLARATION = new RegExp(
  `^\\s*(?:extern\\s+)?(?:fn|macro)\\s+[^;{}]*?\\b(${C3_QUALIFIED_IDENTIFIER_PATTERN})\\.${C3_PARTIAL_IDENTIFIER_PATTERN}$`,
);

const IMPLICIT_TYPE_METHOD_DECLARATION = new RegExp(
  `^\\s*(?:extern\\s+)?(?!(?:return|if|while|for|foreach|foreach_r|switch|case|catch|defer|assert)\\b)[^;{}=]*?\\s+(${C3_QUALIFIED_IDENTIFIER_PATTERN})\\.${C3_PARTIAL_IDENTIFIER_PATTERN}$`,
);

export type AttributeCompletionContext = {
  prefix: string;
  replaceRange: Range;
};

export type ModulePathCompletionContext = {
  pathPrefix: string;
  replaceRange: Range;
};

export type CallArgumentContext = {
  callee: string;
  calleePosition: Position;
  argumentsText: string;
};

export type StructInitializerFieldCompletionContext = {
  typeName: string;
  prefix: string;
  replaceRange: Range;
};

export function attributeCompletionBeforeCursor(
  doc: TextDocument,
  position: Position,
): AttributeCompletionContext | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const match = before.match(
    /(^|[^A-Za-z0-9_$@])(@(?:[A-Za-z_][A-Za-z0-9_]*)?)$/,
  );

  if (!match?.[2]) return null;

  const token = match[2];

  return {
    prefix: token.slice(1),
    replaceRange: {
      start: doc.positionAt(offset - token.length + 1),
      end: position,
    },
  };
}

export function typeMethodDeclarationBeforeCursor(
  doc: TextDocument,
  position: Position,
): { receiver: string; position: Position } | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const match =
    explicitTypeMethodDeclarationBeforeCursor(line) ??
    implicitTopLevelTypeMethodDeclarationBeforeCursor(text, lineStart, line);

  if (!match?.[1]) return null;

  const receiverStart = line.lastIndexOf(match[1]);
  if (receiverStart < 0) return null;

  return {
    receiver: match[1],
    position: doc.positionAt(lineStart + receiverStart),
  };
}

export function memberAccessBeforeCursor(
  doc: TextDocument,
  position: Position,
): { receiver: string; position: Position } | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const match = before.match(
    /((?:[&*]\s*)?(?:\([^()\n]+\)|[A-Za-z_$@][A-Za-z0-9_$@]*(?:(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)|\([^()\n]*\)|\[[^\]\n]*\]|\.[A-Za-z_$@][A-Za-z0-9_$@]*)*))\.(?:[A-Za-z_$@][A-Za-z0-9_$@]*)?$/,
  );

  if (!match || match.index == null) return null;

  return {
    receiver: match[1],
    position: doc.positionAt(match.index + match[1].length),
  };
}

export function structInitializerFieldBeforeCursor(
  doc: TextDocument,
  position: Position,
): StructInitializerFieldCompletionContext | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const fieldMatch = before.match(
    /(^|[^A-Za-z0-9_$@])\.\s*([A-Za-z_$@][A-Za-z0-9_$@]*)?$/,
  );

  if (!fieldMatch) return null;

  const prefix = fieldMatch[2] ?? '';
  const braceOffset = unclosedBraceBefore(text, offset);
  if (braceOffset == null) return null;

  const typeName = initializerTypeBeforeBrace(text, braceOffset);
  if (!typeName) return null;

  return {
    typeName,
    prefix,
    replaceRange: {
      start: doc.positionAt(offset - prefix.length),
      end: position,
    },
  };
}

export function dotAccessCompletionBeforeCursor(
  doc: TextDocument,
  position: Position,
): boolean {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);

  return /\.\s*[A-Za-z_$@]*$/.test(before);
}

export function modulePrefixBeforeCursor(
  doc: TextDocument,
  position: Position,
): string | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);

  const match = before.match(
    /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)::$/,
  );

  return match?.[1] ?? null;
}

export function modulePathCompletionBeforeCursor(
  doc: TextDocument,
  position: Position,
): ModulePathCompletionContext | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const pathStart = modulePathStartInLine(line);

  if (pathStart == null) return null;

  const pathListText = line.slice(pathStart);
  if (pathListText.includes(';')) return null;

  const segmentStart = pathStart + pathListText.lastIndexOf(',') + 1;
  const segmentText = line.slice(segmentStart);
  const leadingWhitespace = segmentText.match(/^\s*/)?.[0].length ?? 0;
  const tokenStart = segmentStart + leadingWhitespace;
  const token = line.slice(tokenStart);
  const modulePathToken = new RegExp(
    `^(?:${C3_IDENTIFIER_PATTERN}(?:::${C3_IDENTIFIER_PATTERN})*(?:::)?|)$`,
  );

  if (!modulePathToken.test(token)) {
    return null;
  }

  const segmentPrefix = token.split('::').at(-1) ?? '';
  const replaceStart =
    lineStart + tokenStart + token.length - segmentPrefix.length;

  return {
    pathPrefix: token,
    replaceRange: {
      start: doc.positionAt(replaceStart),
      end: position,
    },
  };
}

export function callArgumentContextBeforeCursor(
  doc: TextDocument,
  position: Position,
): CallArgumentContext | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const parenOffset = openParenBeforeCursor(text, offset);
  if (parenOffset == null) return null;

  const calleeMatch = text
    .slice(0, parenOffset)
    .match(
      /([A-Za-z_$@][A-Za-z0-9_$@]*(?:(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)|\.[A-Za-z_$@][A-Za-z0-9_$@]*)*)\s*$/,
    );
  if (!calleeMatch?.[1] || calleeMatch.index == null) return null;

  const calleeStart = calleeMatch.index;

  return {
    callee: calleeMatch[1],
    calleePosition: doc.positionAt(calleeStart),
    argumentsText: text.slice(parenOffset + 1, offset),
  };
}

export function methodContext(
  callee: string,
): { receiver: string; name: string } | null {
  const separator = callee.lastIndexOf('.');
  if (separator <= 0 || separator === callee.length - 1) return null;

  return {
    receiver: callee.slice(0, separator),
    name: callee.slice(separator + 1),
  };
}

export function namedArgumentsBeforeCursor(text: string): Set<string> {
  const names = new Set<string>();

  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    names.add(match[1]);
  }

  return names;
}

function explicitTypeMethodDeclarationBeforeCursor(
  line: string,
): RegExpMatchArray | null {
  return line.match(EXPLICIT_TYPE_METHOD_DECLARATION);
}

function implicitTopLevelTypeMethodDeclarationBeforeCursor(
  text: string,
  lineStart: number,
  line: string,
): RegExpMatchArray | null {
  if (braceDepthBefore(text, lineStart) !== 0) return null;

  return line.match(IMPLICIT_TYPE_METHOD_DECLARATION);
}

function braceDepthBefore(text: string, offset: number): number {
  let depth = 0;

  for (let index = 0; index < offset; index++) {
    const char = text[index];

    if (char === '{') depth++;
    if (char === '}') depth = Math.max(0, depth - 1);
  }

  return depth;
}

function modulePathStartInLine(line: string): number | null {
  const importMatch = line.match(/^\s*import(?:\s+|$)/);

  if (importMatch) {
    return importMatch[0].length;
  }

  const aliasMatch = line.match(
    new RegExp(
      `^\\s*alias\\s+${C3_IDENTIFIER_PATTERN}\\s*=\\s*module(?:\\s+|$)`,
    ),
  );

  if (aliasMatch) {
    return aliasMatch[0].length;
  }

  return null;
}

function unclosedBraceBefore(text: string, offset: number): number | null {
  const stack: number[] = [];
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < offset; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote !== '`' && char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') {
      stack.push(index);
      continue;
    }

    if (char === '}') {
      stack.pop();
    }
  }

  return stack.at(-1) ?? null;
}

function initializerTypeBeforeBrace(
  text: string,
  braceOffset: number,
): string | null {
  const beforeBrace = text.slice(0, braceOffset);
  const match = beforeBrace.match(
    new RegExp(`(${C3_QUALIFIED_IDENTIFIER_PATTERN})\\s*$`),
  );

  if (!match?.[1] || match.index == null) return null;

  const beforeType = beforeBrace.slice(0, match.index).trimEnd();
  if (/\b(?:struct|union|bitstruct|enum|interface)\s*$/.test(beforeType)) {
    return null;
  }

  return match[1];
}

function openParenBeforeCursor(text: string, offset: number): number | null {
  let depth = 0;

  for (let index = offset - 1; index >= 0; index--) {
    const char = text[index];

    if (char === ')') {
      depth++;
      continue;
    }

    if (char === '(') {
      if (depth === 0) return index;
      depth--;
    }
  }

  return null;
}
