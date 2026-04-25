import {
  CompletionItemKind,
  SymbolKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';

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

  const symbolItems: CompletionItem[] = index
    .visibleSymbolsAt(current.uri, position)
    .map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    }));

  return [...keywordCompletions(), ...symbolItems];
}

function memberAccessBeforeCursor(
  doc: TextDocument,
  position: Position,
): { receiver: string; position: Position } | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const match = before.match(
    /((?:[&*]\s*)?(?:\([^()\n]+\)|[A-Za-z_$@][A-Za-z0-9_$@]*(?:(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)|\([^()\n]*\)|\[[^\]\n]*\]|\.[A-Za-z_$@][A-Za-z0-9_$@]*)*))\.$/,
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

function keywordCompletions(): CompletionItem[] {
  const keywords = [
    'module',
    'import',
    'fn',
    'struct',
    'union',
    'enum',
    'interface',
    'macro',
    'fault',
    'faultdef',
    'typedef',
    'alias',
    'const',
    'return',
    'defer',
    'catch',
    'if',
    'else',
    'while',
    'foreach',
    'switch',
    '@pool',
    '@dynamic',
  ];

  return keywords.map((keyword) => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
  }));
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

  if (!mod) return [];

  const symbols = [...mod.symbols.values()].flat();

  return symbols.map((symbol) => ({
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  }));
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
