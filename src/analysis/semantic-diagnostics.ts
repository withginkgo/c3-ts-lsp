import {
  DiagnosticSeverity,
  SymbolKind,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { isBuiltinTypeName } from '../shared/builtin-types.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import { callTargetFor } from '../shared/calls.js';
import { isOptionalTypeName, typeNamesCompatible } from '../shared/type-ref.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';
import { checkConstExpr } from './const-expr.js';
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
    const genericMissingParameters = genericTypeMissingParameters(
      parsed,
      ref,
      result.selected,
    );

    if (genericMissingParameters) {
      diagnostics.push(genericMissingParameters);
      continue;
    }

    if (
      result.reason === 'not_found' &&
      !resolvesAsGenericValueArgument(index, parsed, ref, typeName)
    ) {
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

function genericTypeMissingParameters(
  parsed: ParsedDocument,
  ref: SyntaxNode,
  symbol: C3Symbol | undefined,
): Diagnostic | undefined {
  if (!symbol) return undefined;

  const typeInfo = symbol?.typeInfo;
  const genericParameterCount =
    typeInfo?.effectiveGenericParams?.length ?? typeInfo?.genericParameterCount;

  if (!typeInfo?.isGeneric || !genericParameterCount) {
    return undefined;
  }

  if (typeInfo.kind === 'fault-value' || typeInfo.kind === 'builtin') {
    return undefined;
  }

  if (isParameterizedTypeReference(ref)) return undefined;
  if (isSameGenericModuleReference(parsed, symbol)) return undefined;

  return {
    severity: DiagnosticSeverity.Error,
    range: typeReferenceRange(ref),
    message: `'${symbol.name}' is a generic ${typeInfo.kind}, did you forget the parameters '{ ... }'?`,
    source: diagnosticSource,
  };
}

function isParameterizedTypeReference(ref: SyntaxNode): boolean {
  return ref.parent?.type === 'generic_type_ident';
}

function resolvesAsGenericValueArgument(
  index: ProjectIndex,
  parsed: ParsedDocument,
  ref: SyntaxNode,
  typeName: string,
): boolean {
  if (!isGenericArgumentTypeReference(ref)) return false;

  return !!index.resolveSymbol(parsed.uri, typeName, rangeFromNode(ref).start)
    .selected;
}

function isGenericArgumentTypeReference(ref: SyntaxNode): boolean {
  const typeNode = ancestorOfType(ref, 'type');
  return typeNode?.parent?.type === 'generic_arg_list';
}

function isSameGenericModuleReference(
  parsed: ParsedDocument,
  symbol: C3Symbol,
): boolean {
  return (
    symbol.typeInfo?.genericSource === 'module' &&
    symbol.moduleName === parsed.moduleName
  );
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
    ...invalidOptionalDeclarationDiagnostics(parsed),
    ...entryPointDiagnostics(parsed),
  ].sort((a, b) => compareRanges(a.range, b.range));
}

export function expressionDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...rethrowDiagnostics(index, parsed),
    ...globalInitializerDiagnostics(index, parsed),
    ...initializerDiagnostics(index, parsed),
    ...assignmentDiagnostics(index, parsed),
    ...conditionDiagnostics(index, parsed),
    ...discardedCallResultDiagnostics(index, parsed),
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
        if (hasAttribute(requirement, '@optional')) continue;

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

function invalidOptionalDeclarationDiagnostics(
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const declaration of declarationNodes(parsed.tree.rootNode)) {
    const type = declaration.childForFieldName('type');
    if (!type || !isPlainVoidOptionalType(type.text)) continue;

    const name = declaration.childForFieldName('name')?.text ?? 'declaration';

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(type),
      message: `Cannot declare '${name}' with type 'void?'`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function entryPointDiagnostics(parsed: ParsedDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const symbol of flattenSymbols(parsed.symbols).filter(
    isCallableSymbol,
  )) {
    if (symbol.name !== 'main') continue;
    if (!isOptionalTypeName(symbol.returnType)) continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: symbol.selectionRange,
      message: "Function 'main' cannot return an optional",
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function globalInitializerDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const declaration of declarationNodes(parsed.tree.rootNode)) {
    const value = declaration.childForFieldName('right');
    if (!value) continue;

    const context = variableInitializerContext(declaration);

    if (context.externGlobal) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(value),
        message: 'Extern globals may not have initializers.',
        source: diagnosticSource,
      });
      continue;
    }

    if (context.multipleDeclaration) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(value),
        message: 'Initialization is not allowed with multiple declarations.',
        source: diagnosticSource,
      });
      continue;
    }

    if (!context.requiresGlobalInitExpression) continue;

    const result = checkConstExpr(value, { index, parsed });
    if (result.kind !== 'not_const') continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(value),
      message: 'The expression must be a constant value.',
      source: diagnosticSource,
    });
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

type VariableInitializerContext = {
  externGlobal: boolean;
  multipleDeclaration: boolean;
  requiresGlobalInitExpression: boolean;
};

function variableInitializerContext(
  declaration: SyntaxNode,
): VariableInitializerContext {
  const isConst = declaration.type === 'const_declaration';
  const isGlobal = declaration.parent?.type === 'global_declaration';
  const isStatic = hasDirectToken(declaration, 'static');
  const isThreadLocal = hasDirectToken(declaration, 'tlocal');
  const externGlobal =
    isGlobal &&
    !!declaration.parent &&
    hasDirectToken(declaration.parent, 'extern');
  const multipleDeclaration =
    declaration.type === 'declaration' &&
    !!directChildOfType(declaration, 'identifier_list')?.namedChildren.length;

  return {
    externGlobal,
    multipleDeclaration,
    requiresGlobalInitExpression:
      isGlobal || isStatic || isThreadLocal || isConst,
  };
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

function rethrowDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const rethrow of nodesOfType(parsed.tree.rootNode, 'rethrow_expr')) {
    const forceUnwrap = isForceUnwrapRethrow(rethrow);

    if (!forceUnwrap && ancestorOfType(rethrow, 'defer_stmt')) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(rethrow),
        message: 'Rethrows are not allowed inside of defers.',
        source: diagnosticSource,
      });
      continue;
    }

    const argument =
      rethrow.childForFieldName('argument') ?? rethrow.namedChildren[0];
    const argumentType = argument
      ? expressionTypeName(index, parsed, argument)
      : undefined;

    if (argumentType && !isOptionalTypeName(argumentType)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(rethrow),
        message: noOptionalToUnwrapMessage(forceUnwrap),
        source: diagnosticSource,
      });
      continue;
    }

    if (forceUnwrap) continue;

    const callable = enclosingCallable(rethrow);
    if (!callable) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(rethrow),
        message: 'Rethrow cannot be used outside of a function.',
        source: diagnosticSource,
      });
      continue;
    }

    const returnType = callableReturnType(callable);
    if (!returnType || isOptionalTypeName(returnType)) continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(rethrow),
      message: rethrowInNonOptionalCallableMessage(
        callableName(callable),
        returnType,
        expectedTypeForRethrow(index, parsed, rethrow),
      ),
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function discardedCallResultDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const statement of nodesOfType(parsed.tree.rootNode, 'expr_stmt')) {
    const expression = statement.namedChildren[0];
    if (!expression || !containsCallExpression(expression)) continue;

    const callable = directDiscardedCallable(index, parsed, expression);
    const actualType = expressionTypeName(index, parsed, expression);
    const discardsOptional = isOptionalTypeName(actualType);
    const discardsNoDiscard = callable && hasAttribute(callable, '@nodiscard');

    if (discardsOptional && callable && hasAttribute(callable, '@maydiscard')) {
      continue;
    }

    if (!discardsOptional && !discardsNoDiscard) continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(expression),
      message: discardedCallResultMessage(callable, discardsOptional),
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
    if (node.type === 'doc_comment') return;

    if (node.type === 'path_type_ident' && isTypeReferenceContext(node)) {
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

function isTypeReferenceContext(ref: SyntaxNode): boolean {
  const typeNode = ancestorOfType(ref, 'type');
  return !!typeNode && isTypeReferenceTypeNode(typeNode);
}

function isTypeReferenceTypeNode(typeNode: SyntaxNode): boolean {
  const parent = typeNode.parent;
  if (!parent) return false;

  if (sameSyntaxNode(parent.childForFieldName('type'), typeNode)) return true;
  if (sameSyntaxNode(parent.childForFieldName('return_type'), typeNode)) {
    return true;
  }

  if (parent.type === 'typed_initializer_list') return true;
  if (
    parent.type === 'cast_expr' &&
    sameSyntaxNode(parent.childForFieldName('type'), typeNode)
  ) {
    return true;
  }

  if (parent.type === 'generic_arg_list') {
    const owner = parent.parent;
    if (owner?.type === 'trailing_generic_expr') return true;

    return owner?.type === 'generic_type_ident'
      ? isGenericTypeIdentInTypeReferenceContext(owner)
      : false;
  }

  return false;
}

function isGenericTypeIdentInTypeReferenceContext(node: SyntaxNode): boolean {
  const typeNode = node.parent?.type === 'type' ? node.parent : undefined;
  return !!typeNode && isTypeReferenceTypeNode(typeNode);
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
    if (node.type === 'doc_comment') return;

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

function isPlainVoidOptionalType(typeName: string): boolean {
  return /^void[!?~]$/.test(compactTypeText(typeName));
}

function compactTypeText(typeName: string): string {
  return typeName
    .replace(/\b(?:const|volatile)\s+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{},\[\]*!?~])\s*/g, '$1')
    .trim();
}

function directDiscardedCallable(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
): C3Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type !== 'call_expr') return undefined;

  const functionNode = unwrapped.childForFieldName('function');
  if (!functionNode) return undefined;

  const target = callTargetFor(functionNode);
  if (!target) return undefined;

  const symbol = index.resolveCallableSymbol(
    parsed.uri,
    target.ref,
    target.position,
  ).selected;

  return symbol && isCallableSymbol(symbol) ? symbol : undefined;
}

function unwrapExpression(expression: SyntaxNode): SyntaxNode {
  if (expression.type === 'paren_expr' && expression.namedChildren[0]) {
    return unwrapExpression(expression.namedChildren[0]!);
  }

  return expression;
}

function containsCallExpression(expression: SyntaxNode): boolean {
  if (expression.type === 'call_expr') return true;

  return expression.namedChildren.some((child) =>
    containsCallExpression(child),
  );
}

function isForceUnwrapRethrow(node: SyntaxNode): boolean {
  return node.text.trim().endsWith('!!');
}

function noOptionalToUnwrapMessage(forceUnwrap: boolean): string {
  const marker = forceUnwrap ? '!!' : '!';
  return `No optional to rethrow before '${marker}' in the expression, please remove '${marker}'.`;
}

function enclosingCallable(node: SyntaxNode): SyntaxNode | undefined {
  let current = node.parent;

  while (current) {
    if (
      current.type === 'func_definition' ||
      current.type === 'macro_declaration'
    ) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function callableReturnType(callable: SyntaxNode): string | undefined {
  return callableHeader(callable)?.childForFieldName('return_type')?.text;
}

function callableName(callable: SyntaxNode): string {
  return callableHeader(callable)?.childForFieldName('name')?.text ?? '<fn>';
}

function callableHeader(callable: SyntaxNode): SyntaxNode | undefined {
  return callable.namedChildren.find(
    (child) => child.type === 'func_header' || child.type === 'macro_header',
  );
}

function expectedTypeForRethrow(
  index: ProjectIndex,
  parsed: ParsedDocument,
  rethrow: SyntaxNode,
): string | undefined {
  const declaration = ancestorOfType(rethrow, 'declaration');
  const declarationValue = declaration?.childForFieldName('right');
  if (
    declaration &&
    declarationValue &&
    containsNode(declarationValue, rethrow)
  ) {
    return declaration.childForFieldName('type')?.text;
  }

  const assignment = ancestorOfType(rethrow, 'assignment_expr');
  const assignmentRight =
    assignment?.childForFieldName('right') ?? assignment?.namedChildren.at(-1);
  const assignmentLeft =
    assignment?.childForFieldName('left') ?? assignment?.namedChildren[0];
  if (
    assignment &&
    assignmentLeft &&
    assignmentRight &&
    containsNode(assignmentRight, rethrow)
  ) {
    return expressionTypeName(index, parsed, assignmentLeft);
  }

  return undefined;
}

function containsNode(root: SyntaxNode, target: SyntaxNode): boolean {
  return (
    target.startIndex >= root.startIndex && target.endIndex <= root.endIndex
  );
}

function rethrowInNonOptionalCallableMessage(
  callable: string,
  returnType: string,
  expectedType: string | undefined,
): string {
  if (expectedType && isOptionalTypeName(expectedType)) {
    return `This expression is doing a rethrow, but '${callable}' returns '${returnType}', which isn't an optional type. Since you are assigning to an optional, maybe you added '!' by mistake?`;
  }

  return `This expression is doing a rethrow, but '${callable}' returns '${returnType}', which isn't an optional type. Did you intend to use '!!' instead?`;
}

function discardedCallResultMessage(
  callable: C3Symbol | undefined,
  optional: boolean,
): string {
  if (callable && optional) {
    return `Optional result of '${callable.name}' must be handled`;
  }

  if (callable) {
    return `Result of '${callable.name}' is annotated @nodiscard and must be used`;
  }

  return 'Optional expression result must be handled';
}

function hasAttribute(symbol: C3Symbol, name: string): boolean {
  return symbol.attributes.some(
    (attribute) => attribute.split('(')[0] === name,
  );
}

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

function sameSyntaxNode(
  left: SyntaxNode | null | undefined,
  right: SyntaxNode | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function hasDirectToken(node: SyntaxNode, type: string): boolean {
  for (let index = 0; index < node.childCount; index++) {
    if (node.child(index)?.type === type) return true;
  }

  return false;
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
