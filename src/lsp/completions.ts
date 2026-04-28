import {
  CompletionItemKind,
  SymbolKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  C3_BUILTIN_ATTRIBUTES,
  C3_COMPILE_TIME_BUILTINS,
  C3_DEFINED_CONSTANTS,
  C3_KEYWORDS,
} from '../shared/language-data.js';
import type { C3Symbol, ParsedDocument } from '../shared/types.js';

export function completionItems(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): CompletionItem[] {
  if (!doc || !current) return keywordCompletions();

  const memberAccess = memberAccessBeforeCursor(doc, position);

  if (memberAccess) {
    return memberCompletions(
      index,
      current,
      memberAccess.receiver,
      memberAccess.position,
    );
  }

  const prefix = modulePrefixBeforeCursor(doc, position);

  if (prefix) {
    return moduleMemberCompletions(index, current, prefix);
  }

  const argumentItems = argumentNameCompletions(index, doc, current, position);

  const symbolItems: CompletionItem[] = index
    .visibleSymbolsAt(current.uri, position)
    .map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    }));

  return [...argumentItems, ...keywordCompletions(), ...symbolItems];
}

function memberAccessBeforeCursor(
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

function modulePrefixBeforeCursor(
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

function argumentNameCompletions(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument,
  position: Position,
): CompletionItem[] {
  const context = callArgumentContextBeforeCursor(doc, position);
  if (!context) return [];

  const callable = callableForContext(index, current, context);
  if (!callable) return [];

  const supplied = namedArgumentsBeforeCursor(context.argumentsText);

  return callableParameters(callable.symbol, {
    methodStyle: callable.methodStyle,
  })
    .filter((parameter) => parameter.name && !supplied.has(parameter.name))
    .map((parameter) => ({
      label: parameter.name!,
      kind: CompletionItemKind.Variable,
      detail: parameter.label,
      insertText: `${parameter.name}: `,
    }));
}

function callableForContext(
  index: ProjectIndex,
  current: ParsedDocument,
  context: CallArgumentContext,
): { symbol: C3Symbol; methodStyle: boolean } | null {
  const method = methodContext(context.callee);

  if (method) {
    const symbol = index
      .memberSymbolsForExpression(
        current.uri,
        method.receiver,
        context.calleePosition,
      )
      .find((candidate) => candidate.name === method.name);

    return symbol && isCallableSymbol(symbol)
      ? { symbol, methodStyle: true }
      : null;
  }

  const result = index.resolveSymbol(
    current.uri,
    context.callee,
    context.calleePosition,
  );
  const symbol = result.selected;

  return symbol && isCallableSymbol(symbol)
    ? { symbol, methodStyle: false }
    : null;
}

type CallArgumentContext = {
  callee: string;
  calleePosition: Position;
  argumentsText: string;
};

function callArgumentContextBeforeCursor(
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

function methodContext(
  callee: string,
): { receiver: string; name: string } | null {
  const separator = callee.lastIndexOf('.');
  if (separator <= 0 || separator === callee.length - 1) return null;

  return {
    receiver: callee.slice(0, separator),
    name: callee.slice(separator + 1),
  };
}

function namedArgumentsBeforeCursor(text: string): Set<string> {
  const names = new Set<string>();

  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    names.add(match[1]);
  }

  return names;
}

function keywordCompletions(): CompletionItem[] {
  return [
    ...C3_KEYWORDS.map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Keyword,
    })),
    ...C3_BUILTIN_ATTRIBUTES.map((attribute) => ({
      label: attribute,
      kind: CompletionItemKind.Property,
    })),
    ...C3_DEFINED_CONSTANTS.map((constant) => ({
      label: constant,
      kind: CompletionItemKind.Constant,
    })),
    ...C3_COMPILE_TIME_BUILTINS.map((builtin) => ({
      label: builtin,
      kind: CompletionItemKind.Function,
    })),
  ];
}

function memberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  receiver: string,
  position: Position,
): CompletionItem[] {
  return index
    .memberSymbolsForExpression(current.uri, receiver, position)
    .map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    }));
}

function moduleMemberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  prefix: string,
): CompletionItem[] {
  const mod = index.resolveModuleFromPrefix(current, prefix);
  const moduleItems = index
    .moduleChildNamesForPrefix(current, prefix)
    .map((name) => ({
      label: name,
      kind: CompletionItemKind.Module,
      detail: `module ${prefix}::${name}`,
    }));

  if (!mod) return moduleItems;

  const symbols = [...mod.symbols.values()].flat();

  return [
    ...moduleItems,
    ...symbols.map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    })),
  ];
}

function toCompletionKind(kind: SymbolKind): CompletionItemKind {
  switch (kind) {
    case SymbolKind.Function:
      return CompletionItemKind.Function;
    case SymbolKind.Method:
      return CompletionItemKind.Method;
    case SymbolKind.Field:
      return CompletionItemKind.Field;
    case SymbolKind.Struct:
      return CompletionItemKind.Struct;
    case SymbolKind.Enum:
      return CompletionItemKind.Enum;
    case SymbolKind.Interface:
      return CompletionItemKind.Interface;
    case SymbolKind.Constant:
      return CompletionItemKind.Constant;
    case SymbolKind.Variable:
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Text;
  }
}
