import {
  CompletionItemKind,
  SymbolKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from './project-index.js';
import type { ParsedDocument } from './types.js';

export function completionItems(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): CompletionItem[] {
  if (!doc || !current) return keywordCompletions();

  const prefix = modulePrefixBeforeCursor(doc, position);

  if (prefix) {
    return moduleMemberCompletions(index, current, prefix);
  }

  const currentModule = index.getModule(current.moduleName);
  const localSymbols = currentModule
    ? [...currentModule.symbols.values()].flat()
    : [];

  const symbolItems: CompletionItem[] = localSymbols.map((symbol) => ({
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  }));

  return [...keywordCompletions(), ...symbolItems];
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
