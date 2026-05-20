import type { SyntaxNode } from 'tree-sitter';
import { Range, type Position } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ParsedDocument } from '../shared/types.js';

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
  typeName?: string;
  designatorDotTyped: boolean;
  prefix: string;
  replaceRange: Range;
};

export type IdentifierCompletionContext = {
  prefix: string;
  replaceRange: Range;
};

export type ModuleNamespaceCompletionContext = {
  prefix: string;
  memberPrefix: string;
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
  const braceOffset = unclosedBraceBefore(text, offset);
  if (braceOffset == null) return null;

  const entryStart = initializerEntryStart(text, braceOffset, offset);
  const entryText = text.slice(entryStart, offset);
  const fieldMatch = entryText.match(/^\s*\.\s*([A-Za-z_$@][A-Za-z0-9_$@]*)?$/);

  if (fieldMatch) {
    const prefix = fieldMatch[1] ?? '';
    const prefixStart = offset - prefix.length;

    return {
      typeName: initializerTypeBeforeBrace(text, braceOffset) ?? undefined,
      designatorDotTyped: true,
      prefix,
      replaceRange: {
        start: doc.positionAt(prefixStart),
        end: position,
      },
    };
  }

  if (!/^\s*$/.test(entryText)) return null;

  return {
    typeName: initializerTypeBeforeBrace(text, braceOffset) ?? undefined,
    designatorDotTyped: false,
    prefix: '',
    replaceRange: {
      start: position,
      end: position,
    },
  };
}

export function identifierCompletionBeforeCursor(
  doc: TextDocument,
  position: Position,
): IdentifierCompletionContext {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const match = before.match(
    /(^|[^A-Za-z0-9_$@])([A-Za-z_$@][A-Za-z0-9_$@]*)$/,
  );
  const prefix = match?.[2] ?? '';

  return {
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

export function moduleNamespaceCompletionBeforeCursor(
  parsed: ParsedDocument,
  position: Position,
): ModuleNamespaceCompletionContext | null {
  const root = parsed.tree.rootNode;
  const separator = namespaceSeparatorEndingAt(root, position);

  if (separator) {
    const prefix =
      moduleResolutionPrefix(separator, position) ??
      referenceTextEndingAt(root, separator.startPosition);
    if (!prefix) return null;

    return {
      prefix,
      memberPrefix: '',
      replaceRange: Range.create(position, position),
    };
  }

  const identifier = identifierEndingAt(root, position);
  if (!identifier) return null;

  const context =
    qualifiedIdentifierContext(identifier) ?? typeAccessIdentifierContext(identifier);
  if (!context) return null;

  return {
    prefix: context.prefix,
    memberPrefix: identifier.text,
    replaceRange: rangeFromNode(identifier),
  };
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
  const match = line.match(IMPLICIT_TYPE_METHOD_DECLARATION);
  if (!match) return null;
  if (braceDepthBefore(text, lineStart) !== 0) return null;

  return match;
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

function namespaceSeparatorEndingAt(
  root: SyntaxNode,
  position: Position,
): SyntaxNode | null {
  if (position.character === 0) return null;

  const node = root.descendantForPosition({
    row: position.line,
    column: position.character - 1,
  });

  return node.type === '::' && sameNodeEndPosition(node, position)
    ? node
    : null;
}

function moduleResolutionPrefix(
  separator: SyntaxNode,
  position: Position,
): string | null {
  const parent = separator.parent;

  if (
    parent?.type !== 'module_resolution' ||
    !sameNodeEndPosition(parent, position) ||
    !parent.text.endsWith('::')
  ) {
    return null;
  }

  return validModulePath(parent.text.slice(0, -2));
}

function referenceTextEndingAt(
  root: SyntaxNode,
  position: SyntaxNode['endPosition'],
): string | null {
  let prefix: string | null = null;

  function visit(node: SyntaxNode): void {
    if (compareNodeEndPosition(node, position) < 0) return;
    if (compareNodeStartPosition(node, position) > 0) return;

    if (sameNodePosition(node.endPosition, position)) {
      const candidate = validModulePath(node.text);
      if (candidate && candidate.length > (prefix?.length ?? 0)) {
        prefix = candidate;
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return prefix;
}

function identifierEndingAt(
  root: SyntaxNode,
  position: Position,
): SyntaxNode | null {
  if (position.character === 0) return null;

  const node = root.descendantForPosition({
    row: position.line,
    column: position.character - 1,
  });

  return isIdentifierNode(node) && sameNodeEndPosition(node, position)
    ? node
    : null;
}

function qualifiedIdentifierContext(
  identifier: SyntaxNode,
): { prefix: string } | null {
  const owner = nearestQualifiedIdentifierOwner(identifier);
  if (!owner) return null;

  const finalIdentifier = owner.namedChildren.at(-1);
  if (!finalIdentifier || !sameSyntaxNode(finalIdentifier, identifier)) {
    return null;
  }

  const prefixParts = owner.namedChildren.flatMap((child) => {
    if (child.type !== 'module_resolution') return [];

    const ident = child.namedChildren.find(isIdentifierNode);
    return ident ? [ident.text] : [];
  });

  if (prefixParts.length === 0) return null;

  return { prefix: prefixParts.join('::') };
}

function nearestQualifiedIdentifierOwner(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;

  while (current) {
    if (
      (current.type === 'ident_expr' ||
        current.type === 'path_ident' ||
        current.type === 'path_type_ident') &&
      current.namedChildren.some((child) => child.type === 'module_resolution')
    ) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function typeAccessIdentifierContext(
  identifier: SyntaxNode,
): { prefix: string } | null {
  const access =
    identifier.type === 'access_ident'
      ? identifier
      : identifier.parent?.type === 'access_ident'
        ? identifier.parent
        : null;
  if (!access) return null;

  const owner = nearestAncestorOfType(access, 'type_access_expr');
  const field = owner?.childForFieldName('field');
  const argument = owner?.childForFieldName('argument');

  if (!field || !argument || !sameSyntaxNode(field, access)) return null;

  return { prefix: argument.text };
}

function nearestAncestorOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;

  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }

  return null;
}

function validModulePath(text: string): string | null {
  return new RegExp(`^${C3_QUALIFIED_IDENTIFIER_PATTERN}$`).test(text)
    ? text
    : null;
}

function isIdentifierNode(node: SyntaxNode): boolean {
  return (
    node.type === 'ident' ||
    node.type === 'type_ident' ||
    node.type === 'const_ident' ||
    node.type === 'at_ident' ||
    node.type === 'at_type_ident' ||
    node.type === 'ct_ident' ||
    node.type === 'ct_type_ident' ||
    node.type === 'ct_const_ident'
  );
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}

function sameNodeEndPosition(node: SyntaxNode, position: Position): boolean {
  return (
    node.endPosition.row === position.line &&
    node.endPosition.column === position.character
  );
}

function sameSyntaxNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return (
    a.type === b.type &&
    sameNodePosition(a.startPosition, b.startPosition) &&
    sameNodePosition(a.endPosition, b.endPosition)
  );
}

function sameNodePosition(
  a: SyntaxNode['startPosition'],
  b: SyntaxNode['startPosition'],
): boolean {
  return a.row === b.row && a.column === b.column;
}

function compareNodeStartPosition(
  node: SyntaxNode,
  position: SyntaxNode['startPosition'],
): number {
  return compareNodePositions(node.startPosition, position);
}

function compareNodeEndPosition(
  node: SyntaxNode,
  position: SyntaxNode['endPosition'],
): number {
  return compareNodePositions(node.endPosition, position);
}

function compareNodePositions(
  a: SyntaxNode['startPosition'],
  b: SyntaxNode['startPosition'],
): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.column - b.column;
}

function initializerEntryStart(
  text: string,
  braceOffset: number,
  offset: number,
): number {
  let entryStart = braceOffset + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = braceOffset + 1; index < offset; index++) {
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

    if (char === '(') {
      parenDepth++;
      continue;
    }

    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === '[') {
      bracketDepth++;
      continue;
    }

    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (char === '{') {
      braceDepth++;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (
      char === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      entryStart = index + 1;
    }
  }

  return entryStart;
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
  const typedInitializer = beforeBrace.match(
    new RegExp(`\\(\\s*(${C3_QUALIFIED_IDENTIFIER_PATTERN})\\s*\\)\\s*$`),
  );

  if (typedInitializer?.[1]) {
    return typedInitializer[1];
  }

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
