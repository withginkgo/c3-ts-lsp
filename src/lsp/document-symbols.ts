import { SymbolKind, type DocumentSymbol } from 'vscode-languageserver/node.js';

import type { C3Symbol, ParsedDocument } from '../shared/types.js';

export function documentSymbols(parsed: ParsedDocument): DocumentSymbol[] {
  return parsed.symbols.map(toDocumentSymbol);
}

function toDocumentSymbol(symbol: C3Symbol): DocumentSymbol {
  const documentSymbol: DocumentSymbol = {
    name: symbol.name,
    detail: symbol.signature,
    kind: symbol.kind,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  };

  const children = [
    ...contractDocumentSymbols(symbol),
    ...symbol.children.map(toDocumentSymbol),
  ];

  if (children.length > 0) {
    documentSymbol.children = children;
  }

  return documentSymbol;
}

function contractDocumentSymbols(symbol: C3Symbol): DocumentSymbol[] {
  return (symbol.contracts ?? [])
    .filter(
      (contract) => contract.kind === 'require' || contract.kind === 'ensure',
    )
    .map((contract) => ({
      name: contract.name,
      detail:
        contract.expressions.length > 0
          ? contract.expressions.join(', ')
          : undefined,
      kind: SymbolKind.Event,
      range: contract.range,
      selectionRange: contract.nameRange ?? contract.range,
      children: [],
    }));
}
