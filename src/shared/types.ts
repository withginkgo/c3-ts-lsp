import type { Tree } from 'tree-sitter';
import type {
  Diagnostic,
  Range,
  SymbolKind,
} from 'vscode-languageserver/node.js';

export type C3Symbol = {
  name: string;
  moduleName: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  bodyRange?: Range;
  signature: string;
  documentation?: string;
  attributes: string[];
  returnType?: string;
  parameters: string[];
  scopeRange?: Range;
  children: C3Symbol[];
};

export type ModuleIndex = {
  name: string;
  files: string[];
  symbols: Map<string, C3Symbol[]>;
  allSymbols: Map<string, C3Symbol[]>;
  imports: Set<string>;
};

export type ParsedDocument = {
  uri: string;
  tree: Tree;
  symbols: C3Symbol[];
  scopedSymbols: C3Symbol[];
  moduleName: string;
  imports: string[];
  diagnostics: Diagnostic[];
};

export type ResolveResult = {
  selected?: C3Symbol;
  candidates: C3Symbol[];
  reason: 'resolved' | 'not_found' | 'ambiguous';
};
