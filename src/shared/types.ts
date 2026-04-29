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
  receiverType?: string;
  implementedInterfaces?: string[];
  parameters: string[];
  parameterDetails?: C3Parameter[];
  scopeRange?: Range;
  children: C3Symbol[];
};

export type C3Parameter = {
  label: string;
  name?: string;
  type?: string;
  optional: boolean;
  variadic: boolean;
  defaultValue?: string;
  receiver?: boolean;
};

export type C3Import = {
  path: string;
  range: Range;
  selectionRange: Range;
  attributes: string[];
};

export type C3ModuleAlias = {
  name: string;
  target: string;
  range: Range;
  selectionRange: Range;
  targetRange: Range;
};

export type ModuleIndex = {
  name: string;
  files: string[];
  symbols: Map<string, C3Symbol[]>;
  allSymbols: Map<string, C3Symbol[]>;
  imports: Set<string>;
  moduleAliases: Map<string, string>;
};

export type SourceKind = 'workspace' | 'stdlib' | 'dependency';

export type ParsedDocument = {
  uri: string;
  source: string;
  sourceKind: SourceKind;
  tree: Tree;
  symbols: C3Symbol[];
  scopedSymbols: C3Symbol[];
  moduleName: string;
  imports: string[];
  importSpecs: C3Import[];
  moduleAliases: C3ModuleAlias[];
  diagnostics: Diagnostic[];
};

export type ResolveResult = {
  selected?: C3Symbol;
  candidates: C3Symbol[];
  reason: 'resolved' | 'not_found' | 'ambiguous';
};
