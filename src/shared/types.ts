import type { Tree } from 'tree-sitter';
import type { Range, SymbolKind } from 'vscode-languageserver/node.js';

export type C3Symbol = {
  name: string;
  moduleName: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  signature: string;
};

export type ModuleIndex = {
  name: string;
  files: string[];
  symbols: Map<string, C3Symbol[]>;
  imports: Set<string>;
};

export type ParsedDocument = {
  uri: string;
  tree: Tree;
  symbols: C3Symbol[];
  moduleName: string;
  imports: string[];
};
