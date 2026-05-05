import {
  DiagnosticSeverity,
  Range,
  SymbolKind,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  callArguments,
  callArgumentsRange,
  callExpressionNodes,
  callTargetFor,
  type C3CallArgument,
  type C3CallTarget,
} from '../shared/calls.js';
import {
  canImplicitlyConvertType,
  collectionElementTypeName,
  parseTypeRef,
  pointerTargetTypeName,
  terminalTypeName,
  typeNamesCompatible,
} from '../shared/type-ref.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';
import { compileTimeDiagnostics } from './compile-time-diagnostics.js';
import { contractDiagnostics } from './contract-diagnostics.js';
import { returnDiagnostics } from './return-diagnostics.js';
import {
  declarationDiagnostics,
  expressionDiagnostics,
  interfaceImplementationDiagnostics,
  typeReferenceDiagnostics,
} from './semantic-diagnostics.js';
import {
  canPassArgumentType,
  callArgumentValueNode,
  comparableTypeCategory,
  expressionTypeName,
} from './type-analysis.js';
import { expectedTypeForExpression } from './expression-context.js';
import {
  callArgumentShapeMatches,
  callableGenericArgumentMatches,
  genericParameterCountForSymbol,
  instantiateCallableForCall,
  nextPositionalIndex,
} from './generic-call-inference.js';

const diagnosticSource = 'c3-lsp';

export function semanticDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const importDiagnostics = [
    ...unresolvedImportDiagnostics(index, parsed),
    ...unresolvedModuleAliasDiagnostics(index, parsed),
  ];
  const returnValueDiagnostics = returnDiagnostics(index, parsed);

  if (parsed.diagnostics.length > 0) {
    return [
      ...importDiagnostics,
      ...returnValueDiagnostics,
      ...diagnosticsOutsideSyntaxErrors(
        parsed,
        recoverableSemanticDiagnostics(index, parsed),
      ),
    ];
  }

  return [
    ...importDiagnostics,
    ...fullSemanticDiagnostics(index, parsed, returnValueDiagnostics),
  ];
}

function fullSemanticDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
  returnValueDiagnostics = returnDiagnostics(index, parsed),
): Diagnostic[] {
  return [
    ...duplicateCallableDiagnostics(index, parsed),
    ...declarationDiagnostics(index, parsed),
    ...methodReceiverDiagnostics(parsed),
    ...contractDiagnostics(index, parsed),
    ...compileTimeDiagnostics(index, parsed),
    ...typeReferenceDiagnostics(index, parsed),
    ...interfaceImplementationDiagnostics(index, parsed),
    ...returnValueDiagnostics,
    ...referenceDiagnostics(index, parsed),
    ...callDiagnostics(index, parsed),
    ...expressionDiagnostics(index, parsed),
  ];
}

function recoverableSemanticDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...duplicateCallableDiagnostics(index, parsed),
    ...declarationDiagnostics(index, parsed),
    ...methodReceiverDiagnostics(parsed),
    ...contractDiagnostics(index, parsed),
    ...compileTimeDiagnostics(index, parsed),
    ...typeReferenceDiagnostics(index, parsed),
    ...callDiagnostics(index, parsed),
    ...expressionDiagnostics(index, parsed),
  ];
}

function methodReceiverDiagnostics(parsed: ParsedDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const symbol of flattenSymbols(parsed.symbols)) {
    if (symbol.kind !== SymbolKind.Method || !symbol.receiverType) continue;

    const receiver = firstCallableParameter(symbol);
    if (
      receiver &&
      receiverParameterMatches(receiver.type, symbol.receiverType)
    ) {
      continue;
    }

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: symbol.selectionRange,
      message: methodReceiverMessage(symbol),
      source: diagnosticSource,
    });
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

function receiverParameterMatches(
  parameterType: string | undefined,
  receiverType: string | undefined,
): boolean {
  if (!parameterType || !receiverType) return false;
  if (typeNamesCompatible(parameterType, receiverType)) return true;

  const target = pointerTargetTypeName(parameterType);
  return !!target && typeNamesCompatible(target, receiverType);
}

function firstCallableParameter(symbol: C3Symbol): C3Parameter | undefined {
  return (
    symbol.parameterDetails?.[0] ??
    (symbol.parameters[0]
      ? {
          label: symbol.parameters[0],
          type: undefined,
          optional: false,
          variadic: false,
        }
      : undefined)
  );
}

function methodReceiverMessage(symbol: C3Symbol): string {
  const receiver = terminalTypeName(symbol.receiverType ?? '') || '<receiver>';
  const returnType = symbol.returnType ?? 'void';

  return `A method must start with an argument of the type it is a method of, e.g. 'fn ${returnType} ${receiver}.${symbol.name}(${receiver}* self)'`;
}

function unresolvedImportDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return parsed.importSpecs
    .filter((imp) => !index.resolveImportedModule(parsed, imp.path))
    .map((imp) => ({
      severity: DiagnosticSeverity.Error,
      range: imp.selectionRange,
      message: `Unresolved import '${imp.path}'`,
      source: diagnosticSource,
    }));
}

function unresolvedModuleAliasDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return parsed.moduleAliases
    .filter((alias) => !index.resolveImportedModule(parsed, alias.target))
    .map((alias) => ({
      severity: DiagnosticSeverity.Error,
      range: alias.targetRange,
      message: `Unresolved module alias target '${alias.target}'`,
      source: diagnosticSource,
    }));
}

function referenceDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [
    ...genericFunctionReferenceDiagnostics(index, parsed),
  ];

  for (const ref of referenceNodes(parsed.tree.rootNode)) {
    pushReferenceDiagnostic(index, parsed, ref, diagnostics);
  }

  for (const ref of memberReferenceNodes(parsed.tree.rootNode)) {
    pushReferenceDiagnostic(index, parsed, ref, diagnostics);
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

function genericFunctionReferenceDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const expression of trailingGenericExpressionNodes(
    parsed.tree.rootNode,
  )) {
    if (isCallFunctionNode(expression)) continue;

    const target = callTargetFor(expression);
    if (!target) continue;

    const result = index.resolveCallableSymbol(
      parsed.uri,
      target.ref,
      target.position,
    );

    if (result.reason === 'not_found') {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: target.range,
        message: `Unresolved function '${target.ref}'`,
        source: diagnosticSource,
      });
      continue;
    }

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: target.genericRange ?? rangeFromNode(expression),
      message: `Generic function reference '${expression.text}' requires call`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function duplicateCallableDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const mod = index.getModule(parsed.moduleName);
  if (!mod) return [];

  const groups = new Map<string, C3Symbol[]>();

  for (const symbol of [...mod.symbols.values()].flat()) {
    if (!isCallableSymbol(symbol)) continue;

    const key = duplicateCallableKey(symbol);
    const symbols = groups.get(key) ?? [];
    symbols.push(symbol);
    groups.set(key, symbols);
  }

  const diagnostics: Diagnostic[] = [];

  for (const symbols of groups.values()) {
    if (symbols.length < 2) continue;

    for (const symbol of symbols) {
      if (symbol.uri !== parsed.uri) continue;

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: symbol.selectionRange,
        message: duplicateCallableMessage(symbol),
        source: diagnosticSource,
      });
    }
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

function duplicateCallableKey(symbol: C3Symbol): string {
  return symbol.kind === SymbolKind.Method
    ? `method:${terminalTypeName(symbol.receiverType ?? '')}:${symbol.name}`
    : `function:${symbol.name}`;
}

function duplicateCallableMessage(symbol: C3Symbol): string {
  if (symbol.kind === SymbolKind.Method) {
    const receiver = terminalTypeName(symbol.receiverType ?? '') || '<unknown>';
    return `Duplicate method '${receiver}.${symbol.name}'`;
  }

  return `Duplicate function '${symbol.name}'`;
}

function callDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const call of callExpressionNodes(parsed.tree.rootNode)) {
    const functionNode = call.childForFieldName('function');
    if (!functionNode) continue;

    const target = callTargetFor(functionNode);
    if (!target) continue;

    diagnostics.push(
      ...resolveCallDiagnostics(
        index,
        parsed,
        call,
        target,
        expectedTypeForExpression(index, parsed, call),
      ),
    );
  }

  return diagnostics;
}

function resolveCallDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
  call: SyntaxNode,
  target: C3CallTarget,
  expectedType: string | undefined,
): Diagnostic[] {
  const result = index.resolveCallableSymbol(
    parsed.uri,
    target.ref,
    target.position,
  );

  if (isMacroBodyParameterCall(parsed, call, target)) {
    return [];
  }

  if (result.reason === 'not_found') {
    return [
      {
        severity: DiagnosticSeverity.Error,
        range: target.range,
        message: `Unresolved function '${target.ref}'`,
        source: diagnosticSource,
      },
    ];
  }

  const genericMatches = callableGenericArgumentMatches(
    result.candidates,
    target,
  );

  if (genericMatches.length === 0) {
    return [
      genericArgumentCountDiagnostic(
        target,
        result.candidates,
        target.genericRange ?? target.range,
      ),
    ];
  }

  const args = callArguments(call);
  const argumentRange = callArgumentsRange(call) ?? rangeFromNode(call);
  const shapeMatches = genericMatches.filter((symbol) =>
    callArgumentShapeMatches(
      callableParameters(symbol, { methodStyle: target.methodStyle }),
      args,
    ),
  );

  if (shapeMatches.length === 0 && genericMatches.length > 1) {
    return [
      {
        severity: DiagnosticSeverity.Error,
        range: argumentRange,
        message: `No matching function overload for '${target.ref}'`,
        source: diagnosticSource,
      },
    ];
  }

  const selected = shapeMatches[0] ?? genericMatches[0];
  if (!selected) return [];

  if (shapeMatches.length > 1) {
    return [
      {
        severity: DiagnosticSeverity.Error,
        range: target.range,
        message: `Ambiguous function call '${target.ref}' (${shapeMatches.length} candidates)`,
        source: diagnosticSource,
      },
    ];
  }

  const instantiated = instantiateCallableForCall(
    selected,
    index,
    parsed,
    target,
    args,
    expectedType,
  );

  return [
    ...validateCallArguments(
      selected,
      index,
      parsed,
      instantiated.parameters,
      args,
      argumentRange,
      instantiated.unresolvedGenericParams,
    ),
    ...validateMacroBodyArguments(selected, call),
  ];
}

function genericArgumentCountDiagnostic(
  target: C3CallTarget,
  candidates: C3Symbol[],
  range: Range,
): Diagnostic {
  const expectedCounts = uniqueNumbers(
    candidates.map(genericParameterCountForSymbol),
  );
  const expected =
    expectedCounts.length === 1
      ? String(expectedCounts[0])
      : expectedCounts.join(' or ');

  return {
    severity: DiagnosticSeverity.Error,
    range,
    message: `Generic function '${target.ref}' expects ${expected} generic argument${expected === '1' ? '' : 's'}, got ${target.genericArgs.length}`,
    source: diagnosticSource,
  };
}

function isMacroBodyParameterCall(
  parsed: ParsedDocument,
  call: SyntaxNode,
  target: C3CallTarget,
): boolean {
  if (!target.ref.startsWith('@')) return false;

  const macro = ancestorOfType(call, 'macro_declaration');
  if (!macro) return false;

  const macroRange = rangeFromNode(macro);
  const symbol = parsed.symbols.find(
    (candidate) =>
      candidate.kind === SymbolKind.Function &&
      candidate.macroBodyName === target.ref &&
      compareRanges(candidate.range, macroRange) === 0,
  );

  return !!symbol;
}

function validateMacroBodyArguments(
  symbol: C3Symbol,
  call: SyntaxNode,
): Diagnostic[] {
  const expected = symbol.macroBodyParameters ?? [];
  const trailing = call.childForFieldName('trailing');
  const args = call.childForFieldName('arguments');
  const supplied = args ? directChildrenOfType(args, 'param') : [];
  const diagnostics: Diagnostic[] = [];

  if (supplied.length > 0 && !symbol.macroBodyName) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(supplied[0]!),
      message: `Only macro calls with a trailing body parameter may have body arguments`,
      source: diagnosticSource,
    });
  }

  if (trailing && !symbol.macroBodyName) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(trailing),
      message: `This macro does not support trailing statements, please remove it`,
      source: diagnosticSource,
    });
    return diagnostics;
  }

  if (!symbol.macroBodyName) return diagnostics;

  if (!trailing) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(call),
      message: `Expected call to have a trailing statement for '${symbol.macroBodyName}'`,
      source: diagnosticSource,
    });
  }

  if (expected.length > supplied.length) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(call),
      message: `Not enough parameters for the macro body, expected ${expected.length}`,
      source: diagnosticSource,
    });
    return diagnostics;
  }

  if (expected.length < supplied.length) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(supplied[expected.length] ?? call),
      message: `Too many parameters for the macro body, expected ${expected.length}`,
      source: diagnosticSource,
    });
    return diagnostics;
  }

  for (let index = 0; index < expected.length; index++) {
    const expectedType = expected[index]?.type;
    const actualType = supplied[index]?.childForFieldName('type')?.text;
    if (!expectedType || !actualType) continue;
    if (typeNamesCompatible(actualType, expectedType)) continue;

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(supplied[index]!),
      message: `Macro body parameter '${expected[index]?.name ?? index + 1}' should be '${expectedType}', got '${actualType}'`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function validateCallArguments(
  symbol: C3Symbol,
  index: ProjectIndex,
  parsed: ParsedDocument,
  parameters: C3Parameter[],
  args: C3CallArgument[],
  callRange: Range,
  unresolvedGenericParams = new Set<string>(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;
  let tooManyPositional = false;

  for (const arg of args) {
    if (arg.name) {
      const namedIndex = parameters.findIndex(
        (parameter) => parameter.name === arg.name,
      );

      if (namedIndex < 0) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: arg.nameRange ?? arg.range,
          message: `Unknown named argument '${arg.name}' for '${symbol.name}'`,
          source: diagnosticSource,
        });
        continue;
      }

      if (supplied.has(namedIndex)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: arg.nameRange ?? arg.range,
          message: `Argument '${arg.name}' is already supplied for '${symbol.name}'`,
          source: diagnosticSource,
        });
        continue;
      }

      supplied.add(namedIndex);
      pushArgumentTypeDiagnostic(
        symbol,
        index,
        parsed,
        parameters[namedIndex]!,
        arg,
        diagnostics,
        unresolvedGenericParams,
      );
      continue;
    }

    const positionalIndex = nextPositionalIndex(
      parameters,
      supplied,
      positionalCursor,
      variadicIndex,
    );

    if (variadicIndex >= 0 && positionalIndex >= variadicIndex) {
      supplied.add(variadicIndex);
      pushArgumentTypeDiagnostic(
        symbol,
        index,
        parsed,
        parameters[variadicIndex]!,
        arg,
        diagnostics,
        unresolvedGenericParams,
      );
      continue;
    }

    if (positionalIndex < parameters.length) {
      supplied.add(positionalIndex);
      positionalCursor = positionalIndex + 1;
      pushArgumentTypeDiagnostic(
        symbol,
        index,
        parsed,
        parameters[positionalIndex]!,
        arg,
        diagnostics,
        unresolvedGenericParams,
      );
    } else {
      tooManyPositional = true;
    }
  }

  const missing = parameters.filter(
    (parameter, index) =>
      !parameter.optional && !parameter.variadic && !supplied.has(index),
  );

  for (const parameter of missing) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: callRange,
      message: `Missing required argument '${parameter.name ?? parameter.label}' for '${symbol.name}'`,
      source: diagnosticSource,
    });
  }

  if (variadicIndex < 0 && tooManyPositional) {
    const expected = argumentRangeLabel(parameters);

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: callRange,
      message: `'${symbol.name}' expects ${expected} argument${expected === '1' ? '' : 's'}, got ${args.length}`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
}

function pushArgumentTypeDiagnostic(
  symbol: C3Symbol,
  index: ProjectIndex,
  parsed: ParsedDocument,
  parameter: C3Parameter,
  arg: C3CallArgument,
  diagnostics: Diagnostic[],
  unresolvedGenericParams: Set<string>,
): void {
  if (!parameter.type) return;

  const value = callArgumentValueNode(arg.node);
  if (!value) return;

  const actualType = expressionTypeName(index, parsed, value);
  if (
    !actualType ||
    (parameter.variadic &&
      parameter.type &&
      canPassCallArgumentType(
        actualType,
        collectionElementTypeName(parameter.type),
        unresolvedGenericParams,
      )) ||
    canPassCallArgumentType(actualType, parameter.type, unresolvedGenericParams)
  ) {
    return;
  }

  diagnostics.push({
    severity: DiagnosticSeverity.Error,
    range: rangeFromNode(value),
    message: `Cannot pass '${actualType}' to parameter '${parameter.name ?? parameter.label}' of '${symbol.name}' with type '${parameter.type}'`,
    source: diagnosticSource,
  });
}

function canPassCallArgumentType(
  actualType: string,
  expectedType: string,
  unresolvedGenericParams: Set<string>,
): boolean {
  if (containsGenericParam(expectedType, unresolvedGenericParams)) return true;
  if (typeNamesCompatible(actualType, expectedType)) return true;
  if (canImplicitlyConvertType(actualType, expectedType)) return true;

  const actualRef = parseTypeRef(actualType);
  const expectedRef = parseTypeRef(expectedType);
  if (actualRef?.terminal === 'any' || expectedRef?.terminal === 'any') {
    return true;
  }

  if (!canPassArgumentType(actualType, expectedType)) return false;

  const actualCategory = comparableTypeCategory(actualType);
  const expectedCategory = comparableTypeCategory(expectedType);
  if (
    actualCategory &&
    expectedCategory &&
    actualCategory === expectedCategory
  ) {
    return true;
  }

  return !(actualRef && expectedRef);
}

function containsGenericParam(
  typeName: string,
  genericParams: Set<string>,
): boolean {
  if (genericParams.size === 0) return false;

  for (const param of genericParams) {
    const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (
      new RegExp(`(^|[^A-Za-z0-9_$@])\\$?${escaped}(?=$|[^A-Za-z0-9_$@])`).test(
        typeName,
      )
    ) {
      return true;
    }
  }

  return false;
}

function argumentRangeLabel(parameters: C3Parameter[]): string {
  const min = parameters.filter(
    (parameter) => !parameter.optional && !parameter.variadic,
  ).length;
  const hasVariadic = parameters.some((parameter) => parameter.variadic);

  if (hasVariadic) return `${min}+`;
  if (min === parameters.length) return String(min);
  return `${min}-${parameters.length}`;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function pushReferenceDiagnostic(
  index: ProjectIndex,
  parsed: ParsedDocument,
  ref: SyntaxNode,
  diagnostics: Diagnostic[],
): void {
  const result = index.resolveSymbol(
    parsed.uri,
    ref.text,
    rangeFromNode(ref).start,
  );

  if (result.reason === 'not_found') {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(ref),
      message: notFoundReferenceMessage(ref),
      source: diagnosticSource,
    });
  }

  if (
    result.reason === 'ambiguous' &&
    result.candidates.every(isCallableSymbol)
  ) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(ref),
      message: `Function '${ref.text}' used as value`,
      source: diagnosticSource,
    });
    return;
  }

  if (result.reason === 'ambiguous') {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(ref),
      message: ambiguousReferenceMessage(ref, result.candidates.length),
      source: diagnosticSource,
    });
    return;
  }

  if (result.selected && isCallableSymbol(result.selected)) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(ref),
      message: `Function '${ref.text}' used as value`,
      source: diagnosticSource,
    });
  }
}

function notFoundReferenceMessage(ref: SyntaxNode): string {
  if (isVariableReference(ref)) {
    return `Undefined variable '${ref.text}'`;
  }

  return `Unresolved symbol '${ref.text}'`;
}

function ambiguousReferenceMessage(ref: SyntaxNode, count: number): string {
  if (isVariableReference(ref)) {
    return `Ambiguous variable '${ref.text}' (${count} candidates)`;
  }

  return `Ambiguous symbol '${ref.text}' (${count} candidates)`;
}

function isVariableReference(ref: SyntaxNode): boolean {
  return ref.type === 'ident_expr' && !isCallTargetReference(ref);
}

function isCallTargetReference(ref: SyntaxNode): boolean {
  if (isTrailingGenericArgument(ref)) return true;

  const parent = ref.parent;
  if (!parent || parent.type !== 'call_expr') return false;

  const functionNode = parent.childForFieldName('function');
  return !!functionNode && sameNode(functionNode, ref);
}

function isTrailingGenericArgument(ref: SyntaxNode): boolean {
  const parent = ref.parent;
  if (parent?.type !== 'trailing_generic_expr') return false;

  const argument = parent.childForFieldName('argument');
  return !!argument && sameNode(argument, ref);
}

function sameNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return (
    a.type === b.type &&
    a.startIndex === b.startIndex &&
    a.endIndex === b.endIndex
  );
}

function ancestorOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  let current = node.parent;

  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }

  return undefined;
}

function isFieldCallTarget(fieldExpr: SyntaxNode): boolean {
  const parent = fieldExpr.parent;
  const genericOwner =
    parent?.type === 'trailing_generic_expr' &&
    sameNode(parent.childForFieldName('argument') ?? parent, fieldExpr)
      ? parent
      : undefined;
  const callOwner = genericOwner?.parent ?? parent;
  if (callOwner?.type !== 'call_expr') return false;

  const functionNode = callOwner.childForFieldName('function');
  return !!functionNode && sameNode(functionNode, genericOwner ?? fieldExpr);
}

function isCallFunctionNode(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type !== 'call_expr') return false;

  const functionNode = parent.childForFieldName('function');
  return !!functionNode && sameNode(functionNode, node);
}

function trailingGenericExpressionNodes(root: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'doc_comment') return;

    if (node.type === 'trailing_generic_expr') {
      nodes.push(node);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return nodes;
}

function directChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === type);
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function referenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'doc_comment') return;

    if (node.type === 'ident_expr') {
      if (!isCallTargetReference(node)) refs.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function memberReferenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'doc_comment') return;

    if (node.type === 'field_expr') {
      const field = node.childForFieldName('field');
      if (field && !isFieldCallTarget(node)) refs.push(field);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function flattenSymbols(symbols: C3Symbol[]): C3Symbol[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(symbol.children),
  ]);
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}

function diagnosticsOutsideSyntaxErrors(
  parsed: ParsedDocument,
  diagnostics: Diagnostic[],
): Diagnostic[] {
  const syntaxRanges = parsed.diagnostics.map((diagnostic) => diagnostic.range);

  return diagnostics.filter(
    (diagnostic) =>
      !syntaxRanges.some((syntaxRange) =>
        rangesOverlap(diagnostic.range, syntaxRange),
      ),
  );
}

function rangesOverlap(a: Range, b: Range): boolean {
  return (
    comparePositions(a.start, b.end) < 0 && comparePositions(b.start, a.end) < 0
  );
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
