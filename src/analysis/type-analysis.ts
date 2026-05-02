import { Range, SymbolKind } from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callArguments, callTargetFor } from '../shared/calls.js';
import { referenceNarrowedAfterCatch } from '../shared/control-flow.js';
import {
  isOptionalTypeName,
  nonOptionalTypeName,
  normalizeTypeName,
  optionalTypeName,
  terminalTypeName,
  typeNamesCompatible,
} from '../shared/type-ref.js';
import type { C3Symbol, ParsedDocument } from '../shared/types.js';

export function expressionTypeName(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
): string | undefined {
  const literal = literalTypeName(expression);
  if (literal) return literal;

  if (expression.type === 'paren_cond') {
    return expression.namedChildren[0]
      ? expressionTypeName(index, parsed, expression.namedChildren[0]!)
      : undefined;
  }

  if (expression.type === 'paren_expr') {
    return expression.namedChildren[0]
      ? expressionTypeName(index, parsed, expression.namedChildren[0]!)
      : undefined;
  }

  if (expression.type === 'call_expr') {
    return callExpressionTypeName(index, parsed, expression);
  }

  if (expression.type === 'rethrow_expr') {
    const value = expression.namedChildren[0];
    const typeName = value
      ? expressionTypeName(index, parsed, value)
      : undefined;
    return typeName ? nonOptionalTypeName(typeName) : undefined;
  }

  if (expression.type === 'elvis_orelse_expr') {
    return orelseExpressionTypeName(index, parsed, expression);
  }

  if (expression.type === 'optional_expr') {
    const value = expression.namedChildren[0];
    const typeName = value
      ? expressionTypeName(index, parsed, value)
      : undefined;
    if (!typeName) return undefined;

    return expression.text.trim().endsWith('~!')
      ? nonOptionalTypeName(typeName)
      : optionalTypeName(typeName);
  }

  if (expression.type === 'binary_expr') {
    const left =
      expression.childForFieldName('left') ?? expression.namedChildren[0];
    const right =
      expression.childForFieldName('right') ?? expression.namedChildren.at(-1);
    const leftType = left ? expressionTypeName(index, parsed, left) : undefined;
    const rightType = right
      ? expressionTypeName(index, parsed, right)
      : undefined;

    if (isBooleanBinaryExpression(expression)) {
      return leftType && isOptionalTypeName(leftType)
        ? 'bool?'
        : rightType && isOptionalTypeName(rightType)
          ? 'bool?'
          : 'bool';
    }

    const typeName = leftType ?? rightType;
    if (!typeName) return undefined;

    return isOptionalTypeName(leftType) || isOptionalTypeName(rightType)
      ? optionalTypeName(typeName)
      : typeName;
  }

  if (expression.type === 'assignment_expr') {
    const left =
      expression.childForFieldName('left') ?? expression.namedChildren[0];
    return left ? expressionTypeName(index, parsed, left) : undefined;
  }

  if (expression.type === 'call_arg') {
    const value = callArgumentValueNode(expression);
    return value ? expressionTypeName(index, parsed, value) : undefined;
  }

  if (expression.type === 'typed_initializer_list') {
    return expression.childForFieldName('type')?.text;
  }

  if (expression.type === 'initializer_list') {
    return inferInitializerListTypeName(index, parsed, expression);
  }

  const typeName = index.typeNameForExpression(
    parsed.uri,
    expression.text,
    rangeFromNode(expression).start,
  );

  if (
    expression.type === 'ident_expr' &&
    typeName &&
    isOptionalTypeName(typeName) &&
    referenceNarrowedAfterCatch(expression)
  ) {
    return nonOptionalTypeName(typeName);
  }

  return typeName;
}

export function callArgumentValueNode(arg: SyntaxNode): SyntaxNode | undefined {
  const name = arg.childForFieldName('name');

  return arg.namedChildren.find((child) => {
    if (!name) return true;
    return (
      child.startIndex !== name.startIndex || child.endIndex !== name.endIndex
    );
  });
}

function inferInitializerListTypeName(
  index: ProjectIndex,
  parsed: ParsedDocument,
  initializerList: SyntaxNode,
): string | undefined {
  const fieldNames = initializerListFieldNames(initializerList);
  if (fieldNames.length === 0) return undefined;

  const candidates = index
    .visibleSymbols(parsed)
    .filter(isAggregateTypeSymbol)
    .filter((symbol) =>
      fieldNames.every((fieldName) =>
        symbol.children.some((child) => child.name === fieldName),
      ),
    );

  if (candidates.length !== 1) return undefined;
  return candidates[0]?.name;
}

function initializerListFieldNames(initializerList: SyntaxNode): string[] {
  const names: string[] = [];

  for (const element of initializerList.namedChildren) {
    if (element.type !== 'initializer_element') continue;

    const path =
      element.childForFieldName('left') ??
      directChildOfType(element, 'param_path');
    const field = path ? lastDescendantOfTypes(path, ['ident']) : undefined;
    if (field) names.push(field.text);
  }

  return [...new Set(names)];
}

function isAggregateTypeSymbol(symbol: C3Symbol): boolean {
  return (
    symbol.kind === SymbolKind.Struct ||
    symbol.kind === SymbolKind.Enum ||
    symbol.kind === SymbolKind.Interface
  );
}

export function literalTypeName(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case 'integer_literal':
      return 'int';
    case 'real_literal':
      return 'float';
    case 'char_literal':
      return 'char';
    case 'string_literal':
      return 'String';
    case 'true':
    case 'false':
    case 'boolean_literal':
      return 'bool';
    default:
      return undefined;
  }
}

export function shouldReportTypeMismatch(
  actualType: string,
  expectedType: string,
  expression?: SyntaxNode,
): boolean {
  if (isOptionalTypeName(actualType) && !isOptionalTypeName(expectedType)) {
    return true;
  }

  if (
    !isOptionalTypeName(actualType) &&
    isOptionalTypeName(expectedType) &&
    typeNamesCompatible(actualType, nonOptionalTypeName(expectedType))
  ) {
    return false;
  }

  if (
    isOptionalTypeName(actualType) &&
    isOptionalTypeName(expectedType) &&
    typeNamesCompatible(
      nonOptionalTypeName(actualType),
      nonOptionalTypeName(expectedType),
    )
  ) {
    return false;
  }

  if (typeNamesCompatible(actualType, expectedType)) return false;

  const actual = comparableTypeCategory(actualType, expression);
  const expected = comparableTypeCategory(expectedType);

  return !!actual && !!expected && actual !== expected;
}

export function comparableTypeCategory(
  typeName: string,
  expression?: SyntaxNode,
): string | undefined {
  const terminal = terminalTypeName(typeName);

  if (terminal === 'any') return undefined;
  if (integerTypeNames.has(terminal)) return 'integer';
  if (realTypeNames.has(terminal)) return 'real';
  if (terminal === 'bool') return 'bool';
  if (terminal === 'char') return 'char';
  if (terminal === 'String') return 'string';
  if (terminal === 'void') return 'void';

  if (expression?.type === 'integer_literal') return 'integer';
  if (expression?.type === 'real_literal') return 'real';
  if (expression?.type === 'string_literal') return 'string';
  if (expression?.type === 'char_literal') return 'char';
  if (
    expression?.type === 'true' ||
    expression?.type === 'false' ||
    expression?.type === 'boolean_literal'
  ) {
    return 'bool';
  }

  return undefined;
}

export function isBoolType(typeName: string | undefined): boolean {
  return (
    !isOptionalTypeName(typeName) &&
    normalizeTypeName(typeName ?? '') === 'bool'
  );
}

export function canPassArgumentType(
  actualType: string,
  expectedType: string,
): boolean {
  if (
    isOptionalTypeName(actualType) &&
    !isOptionalTypeName(expectedType) &&
    typeNamesCompatible(nonOptionalTypeName(actualType), expectedType)
  ) {
    return true;
  }

  return !shouldReportTypeMismatch(actualType, expectedType);
}

export function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}

function isBooleanBinaryExpression(expression: SyntaxNode): boolean {
  return /(?:&&|\|\||==|!=|<=|>=|<|>)/.test(expression.text);
}

function callExpressionTypeName(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
): string | undefined {
  const functionNode = expression.childForFieldName('function');
  if (!functionNode) return undefined;

  const target = callTargetFor(functionNode);
  const resolved = target
    ? index.resolveCallableSymbol(parsed.uri, target.ref, target.position)
        .selected
    : undefined;
  const returnType =
    resolved?.returnType ??
    index.typeNameForExpression(
      parsed.uri,
      expression.text,
      rangeFromNode(expression).start,
    );

  if (!returnType) return undefined;
  if (isOptionalTypeName(returnType)) return returnType;

  return callArguments(expression).some((arg) => {
    const value = callArgumentValueNode(arg.node);
    const typeName = value
      ? expressionTypeName(index, parsed, value)
      : undefined;
    return isOptionalTypeName(typeName);
  })
    ? optionalTypeName(returnType)
    : returnType;
}

function orelseExpressionTypeName(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
): string | undefined {
  const condition =
    expression.childForFieldName('condition') ?? expression.namedChildren[0];
  if (!condition) return undefined;

  const conditionType = expressionTypeName(index, parsed, condition);
  if (!conditionType) return undefined;

  const fallback =
    expression.childForFieldName('right') ?? expression.namedChildren.at(-1);
  const fallbackType =
    fallback && fallback.startIndex !== condition.startIndex
      ? expressionTypeName(index, parsed, fallback)
      : undefined;

  if (fallbackType && isOptionalTypeName(fallbackType)) {
    return optionalTypeName(conditionType);
  }

  return nonOptionalTypeName(conditionType);
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
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

const integerTypeNames = new Set([
  'char',
  'short',
  'int',
  'long',
  'ichar',
  'ushort',
  'uint',
  'ulong',
  'isz',
  'usz',
  'iptr',
  'uptr',
  'sz',
  'int128',
  'uint128',
]);

const realTypeNames = new Set([
  'float16',
  'float',
  'double',
  'float128',
  'bfloat16',
  'bfloat',
]);
