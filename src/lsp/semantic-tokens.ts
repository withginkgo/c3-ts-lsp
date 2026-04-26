import {
  SemanticTokensBuilder,
  SymbolKind,
  type Range,
  type SemanticTokens,
  type SemanticTokensLegend,
} from 'vscode-languageserver/node.js';

import type { C3Symbol, ParsedDocument } from '../shared/types.js';

export const semanticTokenLegend: SemanticTokensLegend = {
  tokenTypes: [
    'function',
    'method',
    'macro',
    'type',
    'enum',
    'interface',
    'property',
    'variable',
    'enumMember',
  ],
  tokenModifiers: ['declaration', 'readonly'],
};

export function semanticTokens(parsed: ParsedDocument): SemanticTokens {
  const builder = new SemanticTokensBuilder();

  for (const symbol of semanticTokenSymbols(parsed)) {
    const type = tokenTypeForSymbol(symbol);
    if (type == null || !sameLine(symbol.selectionRange)) continue;

    builder.push(
      symbol.selectionRange.start.line,
      symbol.selectionRange.start.character,
      symbol.selectionRange.end.character - symbol.selectionRange.start.character,
      type,
      tokenModifiersForSymbol(symbol),
    );
  }

  return builder.build();
}

function semanticTokenSymbols(parsed: ParsedDocument): C3Symbol[] {
  const seen = new Set<string>();

  return [
    ...flattenSymbols(parsed.symbols),
    ...flattenSymbols(parsed.scopedSymbols),
  ]
    .filter((symbol) => {
      const key = [
        symbol.selectionRange.start.line,
        symbol.selectionRange.start.character,
        symbol.selectionRange.end.character,
      ].join(':');

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareSymbolsByRange);
}

function flattenSymbols(symbols: C3Symbol[]): C3Symbol[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(symbol.children),
  ]);
}

function tokenTypeForSymbol(symbol: C3Symbol): number | undefined {
  const index = semanticTokenLegend.tokenTypes.indexOf(
    tokenTypeNameForSymbol(symbol),
  );

  return index >= 0 ? index : undefined;
}

function tokenTypeNameForSymbol(symbol: C3Symbol): string {
  if (symbol.signature.startsWith('macro ')) return 'macro';

  switch (symbol.kind) {
    case SymbolKind.Function:
      return 'function';
    case SymbolKind.Method:
      return 'method';
    case SymbolKind.Struct:
    case SymbolKind.TypeParameter:
      return 'type';
    case SymbolKind.Enum:
      return 'enum';
    case SymbolKind.Interface:
      return 'interface';
    case SymbolKind.Field:
    case SymbolKind.Property:
      return 'property';
    case SymbolKind.Constant:
      return 'enumMember';
    case SymbolKind.Variable:
      return 'variable';
    default:
      return 'variable';
  }
}

function tokenModifiersForSymbol(symbol: C3Symbol): number {
  let modifiers = 1 << semanticTokenLegend.tokenModifiers.indexOf('declaration');

  if (symbol.kind === SymbolKind.Constant) {
    modifiers |= 1 << semanticTokenLegend.tokenModifiers.indexOf('readonly');
  }

  return modifiers;
}

function compareSymbolsByRange(a: C3Symbol, b: C3Symbol): number {
  return (
    a.selectionRange.start.line - b.selectionRange.start.line ||
    a.selectionRange.start.character - b.selectionRange.start.character
  );
}

function sameLine(range: Range): boolean {
  return range.start.line === range.end.line;
}
