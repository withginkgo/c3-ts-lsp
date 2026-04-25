import type { DocumentSymbol } from 'vscode-languageserver/node.js';

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

  if (symbol.children.length > 0) {
    documentSymbol.children = symbol.children.map(toDocumentSymbol);
  }

  return documentSymbol;
}
