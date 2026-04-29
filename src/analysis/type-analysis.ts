import { Range } from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import {
  normalizeTypeName,
  terminalTypeName,
  typeNamesCompatible,
} from '../shared/type-ref.js';
import type { ParsedDocument } from '../shared/types.js';

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

  if (expression.type === 'binary_expr') {
    if (isBooleanBinaryExpression(expression)) return 'bool';

    const left =
      expression.childForFieldName('left') ?? expression.namedChildren[0];
    const right =
      expression.childForFieldName('right') ?? expression.namedChildren.at(-1);

    return (
      (left ? expressionTypeName(index, parsed, left) : undefined) ??
      (right ? expressionTypeName(index, parsed, right) : undefined)
    );
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

  return index.typeNameForExpression(
    parsed.uri,
    expression.text,
    rangeFromNode(expression).start,
  );
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
  return normalizeTypeName(typeName ?? '') === 'bool';
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
