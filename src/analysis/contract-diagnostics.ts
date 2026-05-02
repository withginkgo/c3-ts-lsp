import {
  DiagnosticSeverity,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  callArguments,
  callExpressionNodes,
  callTargetFor,
  type C3CallArgument,
} from '../shared/calls.js';
import { normalizeTypeName } from '../shared/type-ref.js';
import type {
  C3Contract,
  C3Parameter,
  C3Symbol,
  ParsedDocument,
} from '../shared/types.js';
import {
  constantEnvironmentFromParameters,
  constantExpression,
  constantTypeName,
  type ConstantEnvironment,
  type ConstantValue,
} from './const-eval.js';
import { expressionTypeName, rangeFromNode } from './type-analysis.js';

const diagnosticSource = 'c3-lsp';

export function contractDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...contractDeclarationDiagnostics(index, parsed),
    ...contractCallDiagnostics(index, parsed),
  ].sort((a, b) => compareRanges(a.range, b.range));
}

function contractDeclarationDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const symbol of flattenSymbols(parsed.symbols).filter(
    isCallableSymbol,
  )) {
    if (!symbol.contracts?.length) continue;

    diagnostics.push(...paramContractDiagnostics(symbol));
    diagnostics.push(...expressionContractDiagnostics(index, parsed, symbol));
  }

  return diagnostics;
}

function paramContractDiagnostics(symbol: C3Symbol): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const regularParameters = callableParameters(symbol);
  const bodyParameters = symbol.macroBodyParameters ?? [];
  const parameterByName = new Map<string, C3Parameter>();

  for (const parameter of [...regularParameters, ...bodyParameters]) {
    if (parameter.name) parameterByName.set(parameter.name, parameter);
  }

  let vaParamSeen = false;

  for (const contract of symbol.contracts ?? []) {
    if (contract.kind !== 'param') continue;

    if (contract.parameter === '...') {
      if (vaParamSeen) {
        diagnostics.push(
          error(contract.range, "The '...' @param may not be repeated"),
        );
      }

      vaParamSeen = true;

      if (!regularParameters.some((parameter) => parameter.variadic)) {
        diagnostics.push(
          error(
            contract.parameterRange ?? contract.range,
            "'...' @params are only allowed on macros and functions with a '...' parameter",
          ),
        );
      }

      continue;
    }

    const parameter = contract.parameter
      ? parameterByName.get(contract.parameter)
      : undefined;

    if (!parameter) {
      diagnostics.push(
        error(
          contract.parameterRange ?? contract.range,
          `There is no parameter '${contract.parameter ?? '<missing>'}', did you misspell it?`,
        ),
      );
      continue;
    }

    const modifier = parseParamModifier(contract.modifier);
    if (!modifier) continue;

    if (modifier.byRef && !parameterMayBePointer(parameter)) {
      diagnostics.push(
        error(
          contract.range,
          "'&' can only be added to pointer type parameters",
        ),
      );
    }

    if (modifier.mode !== 'any' && !parameterMayBeInOut(parameter)) {
      diagnostics.push(
        error(
          contract.range,
          "'in', 'out' and 'inout' may only be added to pointers and slices",
        ),
      );
    }
  }

  return diagnostics;
}

function expressionContractDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
  symbol: C3Symbol,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const contractNodes = contractNodesForSymbol(parsed, symbol);
  const parameterTypes = parameterTypeEnvironment(symbol);

  for (const node of contractNodes) {
    const name = node.childForFieldName('name')?.text;
    if (name !== '@require' && name !== '@ensure') continue;

    const contract = symbol.contracts?.find(
      (candidate) =>
        candidate.name === name &&
        sameRange(candidate.range, rangeFromNode(node)),
    );

    for (const expression of contractExpressionNodes(node)) {
      diagnostics.push(
        ...contractReferenceDiagnostics(
          index,
          parsed,
          symbol,
          name,
          expression,
        ),
        ...contractSideEffectDiagnostics(expression),
      );

      if (containsNodeOfType(expression, 'rethrow_expr')) {
        diagnostics.push(
          error(
            rangeFromNode(expression),
            "Rethrows using '!' are not allowed in contracts",
          ),
        );
        continue;
      }

      const value = constantExpression(
        index,
        parsed,
        expression,
        parameterTypes,
      );
      const typeName =
        constantTypeName(value) ??
        contractExpressionTypeName(index, parsed, symbol, expression);

      if (typeName && normalizeTypeName(typeName) !== 'bool') {
        diagnostics.push(
          error(
            rangeFromNode(expression),
            `Contract '${name}' expression should be 'bool', got '${typeName}'`,
          ),
        );
        continue;
      }

      if (value.kind === 'bool' && !value.value) {
        diagnostics.push(
          error(
            rangeFromNode(expression),
            contract?.description
              ? `Contract '${name}' is always false: ${contract.description}`
              : `Contract '${name}' is always false`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

function contractReferenceDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
  symbol: C3Symbol,
  contractName: string | undefined,
  expression: SyntaxNode,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const ident of contractIdentifierExpressions(expression)) {
    if (ident.text === 'return') {
      if (contractName !== '@ensure') {
        diagnostics.push(
          warning(
            rangeFromNode(ident),
            "'return' is only valid in @ensure contracts",
          ),
        );
      }

      continue;
    }

    if (resolveContractIdentifier(index, parsed, symbol, ident.text)) {
      continue;
    }

    diagnostics.push(
      error(
        rangeFromNode(ident),
        `Unresolved symbol '${ident.text}' in contract`,
      ),
    );
  }

  for (const field of contractFieldExpressions(expression)) {
    const argument = field.childForFieldName('argument');
    const member = field.childForFieldName('field');
    if (!argument || !member) continue;

    const typeName = contractExpressionTypeName(
      index,
      parsed,
      symbol,
      argument,
    );
    if (!typeName) continue;

    const resolved = index
      .memberSymbolsForType(parsed.uri, typeName, symbol.selectionRange.start)
      .some((candidate) => candidate.name === member.text);
    if (resolved) continue;

    diagnostics.push(
      error(
        rangeFromNode(member),
        `Type '${typeName}' has no member '${member.text}'`,
      ),
    );
  }

  return diagnostics;
}

function contractSideEffectDiagnostics(expression: SyntaxNode): Diagnostic[] {
  return nodesOfType(expression, 'assignment_expr').map((assignment) =>
    warning(
      rangeFromNode(assignment),
      'Contracts should not contain side-effecting assignments',
    ),
  );
}

function contractCallDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const call of callExpressionNodes(parsed.tree.rootNode)) {
    if (ancestorOfType(call, 'doc_comment')) continue;

    const functionNode = call.childForFieldName('function');
    if (!functionNode) continue;

    const target = callTargetFor(functionNode);
    if (!target) continue;

    const symbol = index.resolveSymbol(
      parsed.uri,
      target.ref,
      target.position,
    ).selected;

    if (!symbol || !isCallableSymbol(symbol) || !symbol.contracts?.length) {
      continue;
    }

    const environment = callConstantEnvironment(
      index,
      parsed,
      symbol,
      target.methodStyle,
      callArguments(call),
    );
    if (!environment) continue;

    for (const contract of symbol.contracts.filter(
      (item) => item.kind === 'require',
    )) {
      for (const expression of contract.expressions) {
        const contractParsed = parsedForSymbol(index, parsed, symbol);
        const expressionNode = contractExpressionNodeByText(
          contractParsed,
          symbol,
          expression,
        );
        if (!expressionNode) continue;

        const value = constantExpression(
          index,
          contractParsed,
          expressionNode,
          environment,
        );

        if (value.kind === 'bool' && !value.value) {
          diagnostics.push(
            error(
              target.range,
              contract.description
                ? `Call to '${symbol.name}' violates @require: ${contract.description}`
                : `Call to '${symbol.name}' violates @require '${expression}'`,
            ),
          );
        }
      }
    }
  }

  return diagnostics;
}

function callConstantEnvironment(
  index: ProjectIndex,
  parsed: ParsedDocument,
  symbol: C3Symbol,
  methodStyle: boolean,
  args: C3CallArgument[],
): ConstantEnvironment | undefined {
  const parameters = callableParameters(symbol, { methodStyle });
  const values: Array<[string | undefined, ConstantValue | undefined]> = [];
  const supplied = new Set<number>();
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = arg.name
      ? parameters.findIndex((parameter) => parameter.name === arg.name)
      : nextPositionalIndex(parameters, supplied, positionalCursor);

    if (parameterIndex < 0 || parameterIndex >= parameters.length) continue;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;

    const valueNode = callArgumentValueNode(arg.node);
    if (!valueNode) continue;

    const value = constantExpression(index, parsed, valueNode);
    values.push([parameters[parameterIndex]?.name, value]);
  }

  return constantEnvironmentFromParameters(values);
}

function contractExpressionTypeName(
  index: ProjectIndex,
  parsed: ParsedDocument,
  symbol: C3Symbol,
  expression: SyntaxNode,
): string | undefined {
  if (expression.type === 'ident_expr') {
    if (expression.text === 'return') return symbol.returnType;

    const parameter = [
      ...callableParameters(symbol),
      ...(symbol.macroBodyParameters ?? []),
    ].find((item) => item.name === expression.text);

    if (parameter?.type) return parameter.type;

    const resolved = resolveContractIdentifier(
      index,
      parsed,
      symbol,
      expression.text,
    );

    return 'returnType' in (resolved ?? {})
      ? (resolved as C3Symbol).returnType
      : (resolved as C3Parameter | undefined)?.type;
  }

  if (expression.type === 'field_expr') {
    const argument = expression.childForFieldName('argument');
    const field = expression.childForFieldName('field');
    if (!argument || !field) return undefined;

    const typeName = contractExpressionTypeName(
      index,
      parsed,
      symbol,
      argument,
    );
    if (!typeName) return undefined;

    return index
      .memberSymbolsForType(parsed.uri, typeName, symbol.selectionRange.start)
      .find((member) => member.name === field.text)?.returnType;
  }

  if (expression.type === 'paren_expr' || expression.type === 'paren_cond') {
    const inner = expression.namedChildren[0];
    return inner
      ? contractExpressionTypeName(index, parsed, symbol, inner)
      : undefined;
  }

  if (expression.type === 'unary_expr') {
    const argument = expression.childForFieldName('argument');
    return argument
      ? contractExpressionTypeName(index, parsed, symbol, argument)
      : undefined;
  }

  if (expression.type === 'binary_expr') {
    return /(?:&&&?|\|\|\|?|==|!=|<=|>=|<|>)/.test(expression.text)
      ? 'bool'
      : expressionTypeName(index, parsed, expression);
  }

  if (expression.type === 'call_expr') {
    const functionNode = expression.childForFieldName('function');
    const resolved = functionNode
      ? index.resolveSymbol(
          parsed.uri,
          functionNode.text,
          rangeFromNode(functionNode).start,
        ).selected
      : undefined;

    return (
      resolved?.returnType ?? expressionTypeName(index, parsed, expression)
    );
  }

  return expressionTypeName(index, parsed, expression);
}

function parameterTypeEnvironment(symbol: C3Symbol): ConstantEnvironment {
  const environment: ConstantEnvironment = new Map();

  for (const parameter of [
    ...callableParameters(symbol),
    ...(symbol.macroBodyParameters ?? []),
  ]) {
    if (!parameter.name || !parameter.type) continue;

    environment.set(parameter.name, {
      kind: 'unknown',
      typeName: parameter.type,
    });
  }

  if (symbol.returnType) {
    environment.set('return', { kind: 'unknown', typeName: symbol.returnType });
  }

  return environment;
}

function contractNodesForSymbol(
  parsed: ParsedDocument,
  symbol: C3Symbol,
): SyntaxNode[] {
  const node = parsed.tree.rootNode.descendantForPosition({
    row: symbol.range.start.line,
    column: symbol.range.start.character,
  });
  const declaration = nearestSymbolDeclaration(node);
  if (!declaration) return [];

  const docComment = directChildOfType(declaration, 'doc_comment');
  return docComment
    ? directChildrenOfType(docComment, 'doc_comment_contract')
    : [];
}

function contractExpressionNodeByText(
  parsed: ParsedDocument,
  symbol: C3Symbol,
  expressionText: string,
): SyntaxNode | undefined {
  for (const node of contractNodesForSymbol(parsed, symbol)) {
    for (const expression of contractExpressionNodes(node)) {
      if (expression.text === expressionText) return expression;
    }
  }

  return undefined;
}

function parsedForSymbol(
  index: ProjectIndex,
  fallback: ParsedDocument,
  symbol: C3Symbol,
): ParsedDocument {
  return index.getParsed(symbol.uri) ?? fallback;
}

function contractExpressionNodes(contract: SyntaxNode): SyntaxNode[] {
  const name = contract.childForFieldName('name');
  const parameter = contract.childForFieldName('parameter');
  const modifier = contract.childForFieldName('mutability_contract');
  const description = contract.childForFieldName('description');

  return contract.namedChildren.filter(
    (child) =>
      !sameSyntaxNode(child, name) &&
      !sameSyntaxNode(child, parameter) &&
      !sameSyntaxNode(child, modifier) &&
      !sameSyntaxNode(child, description),
  );
}

function callArgumentValueNode(arg: SyntaxNode): SyntaxNode | undefined {
  const name = arg.childForFieldName('name');

  return arg.namedChildren.find((child) => {
    if (!name) return true;
    return (
      child.startIndex !== name.startIndex || child.endIndex !== name.endIndex
    );
  });
}

function nextPositionalIndex(
  parameters: C3Parameter[],
  supplied: Set<number>,
  cursor: number,
): number {
  let index = cursor;

  while (index < parameters.length && supplied.has(index)) {
    index++;
  }

  const variadic = parameters.findIndex((parameter) => parameter.variadic);
  if (variadic >= 0 && index >= variadic) return variadic;

  return index;
}

function parseParamModifier(
  modifier: string | undefined,
): { byRef: boolean; mode: 'any' | 'in' | 'out' | 'inout' } | undefined {
  if (!modifier) return undefined;

  const text = modifier.slice(1, -1);
  const byRef = text.startsWith('&');
  const mode = (byRef ? text.slice(1) : text) || 'any';

  return {
    byRef,
    mode: mode === 'in' || mode === 'out' || mode === 'inout' ? mode : 'any',
  };
}

function parameterMayBePointer(parameter: C3Parameter): boolean {
  const type = compactTypeText(parameter.type ?? '');
  return !type || type.endsWith('*') || normalizeTypeName(type) === 'any';
}

function parameterMayBeInOut(parameter: C3Parameter): boolean {
  const type = compactTypeText(parameter.type ?? '');
  return (
    !type ||
    type.endsWith('*') ||
    /\[[^\]]*\]$/.test(type) ||
    normalizeTypeName(type) === 'any'
  );
}

function compactTypeText(typeName: string): string {
  return typeName
    .replace(/\b(?:const|volatile)\s+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{},\[\]*!?~])\s*/g, '$1')
    .trim();
}

function nearestSymbolDeclaration(
  node: SyntaxNode | null,
): SyntaxNode | undefined {
  let current = node;

  while (current) {
    if (
      current.type === 'func_definition' ||
      current.type === 'macro_declaration' ||
      current.type === 'global_declaration' ||
      current.type === 'interface_func_declaration'
    ) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function containsNodeOfType(node: SyntaxNode, type: string): boolean {
  if (node.type === type) return true;
  return node.namedChildren.some((child) => containsNodeOfType(child, type));
}

function nodesOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  function visit(current: SyntaxNode): void {
    if (current.type === type) found.push(current);

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node);
  return found;
}

function contractIdentifierExpressions(expression: SyntaxNode): SyntaxNode[] {
  const identifiers: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'ident_expr') {
      identifiers.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(expression);
  return identifiers;
}

function contractFieldExpressions(expression: SyntaxNode): SyntaxNode[] {
  return nodesOfType(expression, 'field_expr');
}

function resolveContractIdentifier(
  index: ProjectIndex,
  parsed: ParsedDocument,
  symbol: C3Symbol,
  name: string,
): C3Symbol | C3Parameter | undefined {
  const parameter = [
    ...callableParameters(symbol),
    ...(symbol.macroBodyParameters ?? []),
  ].find((item) => item.name === name);

  if (parameter) return parameter;

  const scoped = parsed.scopedSymbols.find(
    (candidate) =>
      candidate.name === name &&
      rangeContainsPosition(symbol.range, candidate.selectionRange.start),
  );
  if (scoped) return scoped;

  return index.resolveSymbol(parsed.uri, name, symbol.selectionRange.start)
    .selected;
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

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function directChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === type);
}

function flattenSymbols(symbols: C3Symbol[]): C3Symbol[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(symbol.children),
  ]);
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

function sameRange(left: Range, right: Range): boolean {
  return (
    comparePositions(left.start, right.start) === 0 &&
    comparePositions(left.end, right.end) === 0
  );
}

function rangeContainsPosition(
  range: Range,
  position: { line: number; character: number },
): boolean {
  return (
    comparePositions(range.start, position) <= 0 &&
    comparePositions(position, range.end) <= 0
  );
}

function error(range: Range, message: string): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range,
    message,
    source: diagnosticSource,
  };
}

function warning(range: Range, message: string): Diagnostic {
  return {
    severity: DiagnosticSeverity.Warning,
    range,
    message,
    source: diagnosticSource,
  };
}

function compareRanges(left: Range, right: Range): number {
  return (
    comparePositions(left.start, right.start) ||
    comparePositions(left.end, right.end)
  );
}

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}
