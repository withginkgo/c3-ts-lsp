import {
  DiagnosticSeverity,
  SymbolKind,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import { terminalTypeName, typeNamesCompatible } from '../shared/type-ref.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';
import {
  expressionTypeName,
  isBoolType,
  rangeFromNode,
  shouldReportTypeMismatch,
} from './type-analysis.js';

const diagnosticSource = 'c3-lsp';

export function typeReferenceDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const genericTypeNames = collectGenericTypeNames(parsed.tree.rootNode);

  for (const ref of typeReferenceNodes(parsed.tree.rootNode)) {
    const typeName = ref.text;

    if (isBuiltinTypeName(typeName)) continue;
    if (genericTypeNames.has(typeName)) continue;
    if (ancestorOfType(ref, 'generic_param_list')) continue;

    const result = index.resolveTypeName(
      parsed.uri,
      typeName,
      rangeFromNode(ref).start,
    );

    if (result.reason === 'not_found') {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: typeReferenceRange(ref),
        message: `Unresolved type '${typeName}'`,
        source: diagnosticSource,
      });
    }

    if (result.reason === 'ambiguous') {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: typeReferenceRange(ref),
        message: `Ambiguous type '${typeName}' (${result.candidates.length} candidates)`,
        source: diagnosticSource,
      });
    }
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

export function declarationDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...duplicateModuleDeclarationDiagnostics(index, parsed),
    ...duplicateMemberDiagnostics(parsed),
    ...duplicateParameterDiagnostics(parsed),
    ...duplicateLocalDeclarationDiagnostics(parsed),
  ].sort((a, b) => compareRanges(a.range, b.range));
}

export function expressionDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...initializerDiagnostics(index, parsed),
    ...assignmentDiagnostics(index, parsed),
    ...conditionDiagnostics(index, parsed),
  ].sort((a, b) => compareRanges(a.range, b.range));
}

export function interfaceImplementationDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const symbol of parsed.symbols) {
    if (!isAggregateTypeSymbol(symbol)) continue;

    for (const interfaceName of symbol.implementedInterfaces ?? []) {
      const resolved = index.resolveTypeName(
        parsed.uri,
        interfaceName,
        symbol.selectionRange.start,
      ).selected;

      if (!resolved || resolved.kind !== SymbolKind.Interface) continue;

      for (const requirement of resolved.children.filter(isCallableSymbol)) {
        if (
          hasConcreteInterfaceImplementation(index, parsed, symbol, requirement)
        ) {
          continue;
        }

        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: symbol.selectionRange,
          message: `Type '${symbol.name}' does not implement interface method '${resolved.name}.${requirement.name}'`,
          source: diagnosticSource,
        });
      }
    }
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

function duplicateModuleDeclarationDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const mod = index.getModule(parsed.moduleName);
  if (!mod) return [];

  const diagnostics: Diagnostic[] = [];

  for (const symbols of mod.symbols.values()) {
    if (symbols.length < 2) continue;
    if (symbols.every(isCallableSymbol)) continue;

    for (const symbol of symbols) {
      if (symbol.uri !== parsed.uri) continue;

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: symbol.selectionRange,
        message: `Duplicate declaration '${symbol.name}'`,
        source: diagnosticSource,
      });
    }
  }

  return diagnostics;
}

function duplicateMemberDiagnostics(parsed: ParsedDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const owner of flattenSymbols(parsed.symbols)) {
    if (!isAggregateTypeSymbol(owner)) continue;

    for (const duplicates of duplicateGroups(owner.children)) {
      for (const member of duplicates) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: member.selectionRange,
          message: `Duplicate member '${member.name}' in '${owner.name}'`,
          source: diagnosticSource,
        });
      }
    }
  }

  return diagnostics;
}

function duplicateParameterDiagnostics(parsed: ParsedDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const callable of flattenSymbols(parsed.symbols).filter(
    isCallableSymbol,
  )) {
    for (const duplicates of duplicateGroups(callable.children)) {
      for (const parameter of duplicates) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: parameter.selectionRange,
          message: `Duplicate parameter '${parameter.name}' in '${callable.name}'`,
          source: diagnosticSource,
        });
      }
    }
  }

  return diagnostics;
}

function duplicateLocalDeclarationDiagnostics(
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const groups = new Map<string, C3Symbol[]>();

  for (const symbol of parsed.scopedSymbols) {
    if (!symbol.scopeRange || !isLocalDeclarationSymbol(symbol)) continue;

    const key = `${rangeKey(symbol.scopeRange)}:${symbol.name}`;
    const symbols = groups.get(key) ?? [];
    symbols.push(symbol);
    groups.set(key, symbols);
  }

  for (const symbols of groups.values()) {
    if (symbols.length < 2) continue;

    for (const symbol of symbols) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: symbol.selectionRange,
        message: `Duplicate local declaration '${symbol.name}'`,
        source: diagnosticSource,
      });
    }
  }

  return diagnostics;
}

function initializerDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const declaration of declarationNodes(parsed.tree.rootNode)) {
    const expectedType = declaration.childForFieldName('type')?.text;
    const value = declaration.childForFieldName('right');
    if (!expectedType || !value) continue;

    const actualType = expressionTypeName(index, parsed, value);
    if (
      !actualType ||
      !shouldReportTypeMismatch(actualType, expectedType, value)
    ) {
      continue;
    }

    const name = declaration.childForFieldName('name')?.text ?? 'declaration';

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(value),
      message: `Cannot initialize '${name}' of type '${expectedType}' with '${actualType}'`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function assignmentDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const assignment of nodesOfType(
    parsed.tree.rootNode,
    'assignment_expr',
  )) {
    const left =
      assignment.childForFieldName('left') ?? assignment.namedChildren[0];
    const right =
      assignment.childForFieldName('right') ?? assignment.namedChildren.at(-1);
    if (!left || !right || left.startIndex === right.startIndex) continue;

    const expectedType = expressionTypeName(index, parsed, left);
    const actualType = expressionTypeName(index, parsed, right);
    if (!expectedType || !actualType) continue;
    if (!shouldReportTypeMismatch(actualType, expectedType, right)) continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(right),
      message: `Cannot assign '${actualType}' to '${left.text}' of type '${expectedType}'`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function conditionDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const node of conditionOwnerNodes(parsed.tree.rootNode)) {
    const condition = node.childForFieldName('condition');
    const expression = conditionExpression(condition);
    if (!expression) continue;

    const actualType = expressionTypeName(index, parsed, expression);
    if (!actualType || isBoolType(actualType)) continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(expression),
      message: `Condition expression should be 'bool', got '${actualType}'`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function hasConcreteInterfaceImplementation(
  index: ProjectIndex,
  parsed: ParsedDocument,
  typeSymbol: C3Symbol,
  requirement: C3Symbol,
): boolean {
  return index
    .memberSymbolsForType(
      parsed.uri,
      typeSymbol.name,
      typeSymbol.selectionRange.start,
    )
    .filter(
      (member) =>
        member.kind === SymbolKind.Method &&
        member.name === requirement.name &&
        !!member.receiverType,
    )
    .some((member) => callableShapesCompatible(member, requirement));
}

function callableShapesCompatible(
  implementation: C3Symbol,
  requirement: C3Symbol,
): boolean {
  if (
    !typeNamesCompatible(
      implementation.returnType ?? 'void',
      requirement.returnType ?? 'void',
    )
  ) {
    return false;
  }

  const actual = callableParameters(implementation, { methodStyle: true });
  const expected = callableParameters(requirement);
  if (actual.length !== expected.length) return false;

  return expected.every((parameter, index) =>
    parametersCompatible(actual[index], parameter),
  );
}

function parametersCompatible(
  actual: C3Parameter | undefined,
  expected: C3Parameter,
): boolean {
  if (!actual) return false;
  if (!actual.type || !expected.type) return true;

  return typeNamesCompatible(actual.type, expected.type);
}

function typeReferenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'path_type_ident') {
      refs.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function typeReferenceRange(node: SyntaxNode): Range {
  const typeName = lastDescendantOfTypes(node, ['type_ident', 'ident']);
  return typeName ? rangeFromNode(typeName) : rangeFromNode(node);
}

function collectGenericTypeNames(root: SyntaxNode): Set<string> {
  const names = new Set<string>();

  for (const list of nodesOfType(root, 'generic_param_list')) {
    for (const child of list.namedChildren) {
      if (child.type === 'type_ident') names.add(child.text);
    }
  }

  return names;
}

function declarationNodes(root: SyntaxNode): SyntaxNode[] {
  return [
    ...nodesOfType(root, 'declaration'),
    ...nodesOfType(root, 'const_declaration'),
  ];
}

function conditionOwnerNodes(root: SyntaxNode): SyntaxNode[] {
  return nodesOfTypes(root, ['if_stmt', 'while_stmt', 'for_cond']);
}

function conditionExpression(
  condition: SyntaxNode | null,
): SyntaxNode | undefined {
  if (!condition) return undefined;
  if (condition.type === 'paren_cond') return condition.namedChildren[0];
  return condition;
}

function nodesOfType(root: SyntaxNode, type: string): SyntaxNode[] {
  return nodesOfTypes(root, [type]);
}

function nodesOfTypes(root: SyntaxNode, types: string[]): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (types.includes(node.type)) found.push(node);

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return found;
}

function duplicateGroups(symbols: C3Symbol[]): C3Symbol[][] {
  const groups = new Map<string, C3Symbol[]>();

  for (const symbol of symbols) {
    const list = groups.get(symbol.name) ?? [];
    list.push(symbol);
    groups.set(symbol.name, list);
  }

  return [...groups.values()].filter((group) => group.length > 1);
}

function flattenSymbols(symbols: C3Symbol[]): C3Symbol[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(symbol.children),
  ]);
}

function isAggregateTypeSymbol(symbol: C3Symbol): boolean {
  return (
    symbol.kind === SymbolKind.Struct ||
    symbol.kind === SymbolKind.Enum ||
    symbol.kind === SymbolKind.Interface ||
    (symbol.kind === SymbolKind.Constant &&
      symbol.signature.startsWith('constdef ') &&
      symbol.children.length > 0)
  );
}

function isLocalDeclarationSymbol(symbol: C3Symbol): boolean {
  return symbol.signature.endsWith(';') || symbol.signature.startsWith('var ');
}

function isBuiltinTypeName(typeName: string): boolean {
  return builtinTypeNames.has(terminalTypeName(typeName));
}

const builtinTypeNames = new Set([
  'any',
  'anyfault',
  'bool',
  'bfloat',
  'bfloat16',
  'char',
  'double',
  'float',
  'float16',
  'float128',
  'ichar',
  'int',
  'int128',
  'iptr',
  'isz',
  'long',
  'short',
  'String',
  'typeid',
  'uint',
  'uint128',
  'ulong',
  'untypedlist',
  'uptr',
  'ushort',
  'usz',
  'void',
]);

function ancestorOfType(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | undefined {
  let current = node?.parent;

  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }

  return undefined;
}

function lastDescendantOfTypes(
  node: SyntaxNode,
  types: string[],
): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;

  function visit(current: SyntaxNode): void {
    if (types.includes(current.type)) {
      found = current;
    }

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node);
  return found;
}

function rangeKey(range: Range): string {
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

function compareRanges(a: Range, b: Range): number {
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

function comparePositions(
  a: { line: number; character: number },
  b: { line: number; character: number },
): number {
  return a.line - b.line || a.character - b.character;
}
