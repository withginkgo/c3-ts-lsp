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
  macroBodyName?: string;
  macroBodyParameters?: C3Parameter[];
  contracts?: C3Contract[];
  typeInfo?: C3TypeDeclarationInfo;
  scopeRange?: Range;
  children: C3Symbol[];
};

export type C3TypeDeclarationKind =
  | 'struct'
  | 'union'
  | 'enum'
  | 'bitstruct'
  | 'alias'
  | 'typedef'
  | 'builtin'
  | 'fault-value'
  | 'constdef'
  | 'interface';

export type C3TypeDeclarationInfo = {
  name: string;
  kind: C3TypeDeclarationKind;
  isGeneric: boolean;
  genericParameterCount: number;
  range: Range;
  selectionRange: Range;
  genericSource?: 'declaration' | 'module';
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

export type C3ContractKind =
  | 'require'
  | 'ensure'
  | 'param'
  | 'return'
  | 'pure'
  | 'other';

export type C3Contract = {
  kind: C3ContractKind;
  name: string;
  nameRange?: Range;
  range: Range;
  expressions: string[];
  expressionRanges: Range[];
  parameter?: string;
  parameterRange?: Range;
  modifier?: string;
  description?: string;
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
  moduleAttributes: string[];
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
