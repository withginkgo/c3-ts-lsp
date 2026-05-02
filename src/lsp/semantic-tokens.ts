import {
  SemanticTokensBuilder,
  SymbolKind,
  type Range,
  type SemanticTokens,
  type SemanticTokensLegend,
} from 'vscode-languageserver/node.js';

import type { ProjectIndex } from '../project/project-index.js';
import type { C3Symbol, ParsedDocument } from '../shared/types.js';
import {
  contractSemanticTokens,
  type ContractSemanticToken,
} from './contracts.js';

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
    'keyword',
    'operator',
  ],
  tokenModifiers: ['declaration', 'readonly'],
};

type SemanticToken = {
  range: Range;
  type: string;
  modifiers: number;
};

export function semanticTokens(
  parsed: ParsedDocument,
  index?: ProjectIndex,
): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  const tokens = [
    ...semanticTokenSymbols(parsed).flatMap(symbolSemanticToken),
    ...contractSemanticTokens(parsed, index).map(contractToken),
  ]
    .filter((token) => sameLine(token.range))
    .sort(compareTokensByRange);

  for (const token of tokens) {
    const type = tokenTypeForName(token.type);
    if (type == null) continue;

    builder.push(
      token.range.start.line,
      token.range.start.character,
      token.range.end.character - token.range.start.character,
      type,
      token.modifiers,
    );
  }

  return builder.build();
}

function symbolSemanticToken(symbol: C3Symbol): SemanticToken[] {
  return [
    {
      range: symbol.selectionRange,
      type: tokenTypeNameForSymbol(symbol),
      modifiers: tokenModifiersForSymbol(symbol),
    },
  ];
}

function contractToken(token: ContractSemanticToken): SemanticToken {
  return {
    range: token.range,
    type: token.type,
    modifiers: 0,
  };
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

function tokenTypeForName(name: string): number | undefined {
  const index = semanticTokenLegend.tokenTypes.indexOf(name);
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
  let modifiers =
    1 << semanticTokenLegend.tokenModifiers.indexOf('declaration');

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

function compareTokensByRange(a: SemanticToken, b: SemanticToken): number {
  return (
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    a.range.end.line - b.range.end.line ||
    a.range.end.character - b.range.end.character
  );
}

function sameLine(range: Range): boolean {
  return range.start.line === range.end.line;
}
