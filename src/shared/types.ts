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
  symbolType?: C3SymbolType;
  uri: string;
  range: Range;
  selectionRange: Range;
  bodyRange?: Range;
  signature: string;
  documentation?: string;
  attributes: string[];
  returnType?: string;
  valueType?: string;
  functionType?: C3FunctionType;
  moduleInfo?: C3ModuleSymbolInfo;
  receiverType?: string;
  implementedInterfaces?: string[];
  parameters: string[];
  parameterDetails?: C3Parameter[];
  genericParameterCount?: number;
  moduleGenericParams?: string[];
  declaredGenericParams?: string[];
  effectiveGenericParams?: string[];
  macroBodyName?: string;
  macroBodyParameters?: C3Parameter[];
  contracts?: C3Contract[];
  typeInfo?: C3TypeDeclarationInfo;
  scopeRange?: Range;
  children: C3Symbol[];
};

export type C3SymbolType =
  | 'module'
  | 'function'
  | 'method'
  | 'struct'
  | 'enum'
  | 'interface'
  | 'type'
  | 'variable'
  | 'field'
  | 'constant'
  | 'property'
  | 'unknown';

export type C3FunctionType = {
  params: C3Parameter[];
  returnType?: string;
  receiverType?: string;
};

export type C3ModuleSymbolInfo = {
  canonicalName: string;
  genericParams: string[];
  alias?: string;
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
  moduleGenericParams?: string[];
  declaredGenericParams?: string[];
  effectiveGenericParams?: string[];
  range: Range;
  selectionRange: Range;
  genericSource?: 'declaration' | 'module' | 'mixed';
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

export type ModuleScope = {
  name: string;
  files: string[];
  genericParams: string[];
  symbols: Map<string, C3Symbol[]>;
  allSymbols: Map<string, C3Symbol[]>;
  imports: Set<string>;
  moduleAliases: Map<string, string>;
};

export type ModuleIndex = ModuleScope;

export type SourceKind = 'workspace' | 'stdlib' | 'dependency';

export type ParsedDocument = {
  uri: string;
  source: string;
  sourceKind: SourceKind;
  tree: Tree;
  symbols: C3Symbol[];
  scopedSymbols: C3Symbol[];
  moduleName: string;
  moduleGenericParams: string[];
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
