import type { SyntaxNode } from 'tree-sitter';
import type { Position } from 'vscode-languageserver/node.js';

import type { ProjectIndex } from '../project/project-index.js';
import { isOptionalTypeName, normalizeTypeName } from '../shared/type-ref.js';
import type { ParsedDocument } from '../shared/types.js';
import { expressionTypeName, rangeFromNode } from './type-analysis.js';

export type ConstantValue =
  | { kind: 'bool'; typeName: string; value: boolean }
  | { kind: 'int'; typeName: string; value: number }
  | { kind: 'float'; typeName: string; value: number }
  | { kind: 'string'; typeName: string; value: string }
  | { kind: 'null'; typeName: string; value: null }
  | { kind: 'type'; typeName: string; value: string }
  | { kind: 'unknown'; typeName?: string };

export type ConstantEnvironment = Map<string, ConstantValue>;

export function constantExpression(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
  environment: ConstantEnvironment = new Map(),
  seen = new Set<string>(),
): ConstantValue {
  const literal = literalConstant(expression);
  if (literal) return literal;

  if (expression.type === 'paren_expr' || expression.type === 'paren_cond') {
    return expression.namedChildren[0]
      ? constantExpression(
          index,
          parsed,
          expression.namedChildren[0]!,
          environment,
          seen,
        )
      : unknown();
  }

  if (expression.type === 'ident_expr') {
    return identifierConstant(index, parsed, expression, environment, seen);
  }

  if (expression.type === 'field_expr') {
    return fieldConstant(index, parsed, expression, environment, seen);
  }

  if (expression.type === 'unary_expr') {
    return unaryConstant(index, parsed, expression, environment, seen);
  }

  if (expression.type === 'binary_expr') {
    return binaryConstant(index, parsed, expression, environment, seen);
  }

  if (expression.type === 'cast_expr') {
    const value = expression.childForFieldName('value');
    const type = expression.childForFieldName('type')?.text;
    if (!value) return unknown(type);

    const inner = constantExpression(index, parsed, value, environment, seen);
    return inner.kind === 'unknown'
      ? unknown(type ?? inner.typeName)
      : { ...inner, typeName: type ?? inner.typeName };
  }

  if (expression.type === 'call_expr') {
    const functionNode = expression.childForFieldName('function');
    if (!functionNode) return unknown();

    const resolved = index.resolveSymbol(
      parsed.uri,
      functionNode.text,
      rangeFromNode(functionNode).start,
    ).selected;

    return unknown(resolved?.returnType);
  }

  const typeName = expressionTypeName(index, parsed, expression);
  return unknown(typeName);
}

export function constantTypeName(value: ConstantValue): string | undefined {
  return value.typeName;
}

export function constantIsBool(
  value: ConstantValue,
): value is Extract<ConstantValue, { kind: 'bool' }> {
  return (
    value.kind === 'bool' || normalizeTypeName(value.typeName ?? '') === 'bool'
  );
}

export function constantEnvironmentFromParameters(
  namesAndValues: Array<[string | undefined, ConstantValue | undefined]>,
): ConstantEnvironment {
  const environment: ConstantEnvironment = new Map();

  for (const [name, value] of namesAndValues) {
    if (name && value) environment.set(name, value);
  }

  return environment;
}

function literalConstant(node: SyntaxNode): ConstantValue | undefined {
  switch (node.type) {
    case 'true':
    case 'boolean_literal':
      return { kind: 'bool', typeName: 'bool', value: true };
    case 'false':
      return { kind: 'bool', typeName: 'bool', value: false };
    case 'integer_literal':
      return { kind: 'int', typeName: 'int', value: parseInteger(node.text) };
    case 'real_literal':
      return {
        kind: 'float',
        typeName: 'float',
        value: Number(node.text.replace(/_/g, '')),
      };
    case 'string_literal':
    case 'raw_string_literal':
    case 'string_expr':
      return {
        kind: 'string',
        typeName: 'String',
        value: stringLiteralValue(node.text),
      };
    case 'null':
      return { kind: 'null', typeName: 'void*', value: null };
    case 'type':
      return { kind: 'type', typeName: 'typeid', value: node.text };
    default:
      return undefined;
  }
}

function identifierConstant(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
  environment: ConstantEnvironment,
  seen: Set<string>,
): ConstantValue {
  const ref = expression.text;
  const env = environment.get(ref);
  if (env) return env;

  const declaration = constDeclarationForReference(
    index,
    parsed,
    ref,
    rangeFromNode(expression).start,
  );
  const value = declaration?.childForFieldName('right');
  if (!declaration || !value) {
    return unknown(expressionTypeName(index, parsed, expression));
  }

  const key = `${declaration.startIndex}:${declaration.endIndex}:${ref}`;
  if (seen.has(key))
    return unknown(declaration.childForFieldName('type')?.text);

  seen.add(key);
  const constant = constantExpression(index, parsed, value, environment, seen);
  seen.delete(key);

  const explicitType = declaration.childForFieldName('type')?.text;
  return constant.kind === 'unknown' || !explicitType
    ? constant
    : { ...constant, typeName: explicitType };
}

function fieldConstant(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
  environment: ConstantEnvironment,
  seen: Set<string>,
): ConstantValue {
  const argument = expression.childForFieldName('argument');
  const field = expression.childForFieldName('field')?.text;
  if (!argument || !field) return unknown();

  const parent = constantExpression(index, parsed, argument, environment, seen);
  if (field === 'len' && parent.kind === 'string') {
    return { kind: 'int', typeName: 'usz', value: parent.value.length };
  }

  return unknown(expressionTypeName(index, parsed, expression));
}

function unaryConstant(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
  environment: ConstantEnvironment,
  seen: Set<string>,
): ConstantValue {
  const argument = expression.childForFieldName('argument');
  if (!argument) return unknown();

  const value = constantExpression(index, parsed, argument, environment, seen);
  const operator = expression.children.find((child) => !child.isNamed)?.text;

  if (operator === '!' && value.kind === 'bool') {
    return { kind: 'bool', typeName: 'bool', value: !value.value };
  }

  if (operator === '-' && (value.kind === 'int' || value.kind === 'float')) {
    return { ...value, value: -value.value };
  }

  if (operator === '+' && (value.kind === 'int' || value.kind === 'float')) {
    return value;
  }

  if (operator === '~' && value.kind === 'int') {
    return { ...value, value: ~value.value };
  }

  return unknown(expressionTypeName(index, parsed, expression));
}

function binaryConstant(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
  environment: ConstantEnvironment,
  seen: Set<string>,
): ConstantValue {
  const leftNode =
    expression.childForFieldName('left') ?? expression.namedChildren[0];
  const rightNode =
    expression.childForFieldName('right') ?? expression.namedChildren.at(-1);
  const operator = expression.children.find((child) => !child.isNamed)?.text;
  if (!leftNode || !rightNode || !operator) return unknown();

  const left = constantExpression(index, parsed, leftNode, environment, seen);
  const right = constantExpression(index, parsed, rightNode, environment, seen);

  if (operator === '&&' || operator === '&&&') {
    if (left.kind === 'bool' && !left.value) return bool(false);
    if (left.kind === 'bool' && right.kind === 'bool')
      return bool(left.value && right.value);
    return unknown('bool');
  }

  if (operator === '||' || operator === '|||') {
    if (left.kind === 'bool' && left.value) return bool(true);
    if (left.kind === 'bool' && right.kind === 'bool')
      return bool(left.value || right.value);
    return unknown('bool');
  }

  if (comparisonOperators.has(operator)) {
    return compareConstants(operator, left, right);
  }

  if (
    (left.kind === 'int' || left.kind === 'float') &&
    (right.kind === 'int' || right.kind === 'float')
  ) {
    return arithmeticConstant(operator, left, right);
  }

  if (
    (operator === '+' || operator === '+++') &&
    left.kind === 'string' &&
    right.kind === 'string'
  ) {
    return {
      kind: 'string',
      typeName: 'String',
      value: left.value + right.value,
    };
  }

  const leftType = constantTypeName(left);
  const rightType = constantTypeName(right);
  return unknown(
    leftType && !isOptionalTypeName(leftType) ? leftType : rightType,
  );
}

function compareConstants(
  operator: string,
  left: ConstantValue,
  right: ConstantValue,
): ConstantValue {
  if (left.kind === 'unknown' || right.kind === 'unknown')
    return unknown('bool');

  switch (operator) {
    case '==':
      return bool(left.value === right.value);
    case '!=':
      return bool(left.value !== right.value);
    case '<':
      return comparable(left, right)
        ? bool(comparableValue(left) < comparableValue(right))
        : unknown('bool');
    case '<=':
      return comparable(left, right)
        ? bool(comparableValue(left) <= comparableValue(right))
        : unknown('bool');
    case '>':
      return comparable(left, right)
        ? bool(comparableValue(left) > comparableValue(right))
        : unknown('bool');
    case '>=':
      return comparable(left, right)
        ? bool(comparableValue(left) >= comparableValue(right))
        : unknown('bool');
    default:
      return unknown('bool');
  }
}

function arithmeticConstant(
  operator: string,
  left: ConstantValue,
  right: ConstantValue,
): ConstantValue {
  if (
    (left.kind !== 'int' && left.kind !== 'float') ||
    (right.kind !== 'int' && right.kind !== 'float')
  ) {
    return unknown();
  }

  const typeName =
    left.kind === 'float' || right.kind === 'float' ? 'float' : left.typeName;

  switch (operator) {
    case '+':
    case '+++':
      return numberValue(typeName, left.value + right.value);
    case '-':
      return numberValue(typeName, left.value - right.value);
    case '*':
      return numberValue(typeName, left.value * right.value);
    case '/':
      return right.value === 0
        ? unknown(typeName)
        : numberValue(typeName, left.value / right.value);
    case '%':
      return right.value === 0
        ? unknown(typeName)
        : numberValue(typeName, left.value % right.value);
    case '<<':
      return numberValue(typeName, left.value << right.value);
    case '>>':
      return numberValue(typeName, left.value >> right.value);
    case '&':
      return numberValue(typeName, left.value & right.value);
    case '|':
      return numberValue(typeName, left.value | right.value);
    case '^':
      return numberValue(typeName, left.value ^ right.value);
    default:
      return unknown(typeName);
  }
}

function constDeclarationForReference(
  index: ProjectIndex,
  parsed: ParsedDocument,
  ref: string,
  position: Position,
): SyntaxNode | undefined {
  const resolved = index.resolveSymbol(parsed.uri, ref, position).selected;
  const owner = resolved ? index.getParsed(resolved.uri) : parsed;
  if (!owner) return undefined;
  const selectionStart = resolved?.selectionRange.start;

  for (const declaration of nodesOfType(
    owner.tree.rootNode,
    'const_declaration',
  )) {
    const name = declaration.childForFieldName('name');
    if (name?.text !== ref) continue;

    if (
      selectionStart &&
      (name.startPosition.row !== selectionStart.line ||
        name.startPosition.column !== selectionStart.character)
    ) {
      continue;
    }

    if (
      !selectionStart &&
      comparePositions(rangeFromNode(name).start, position) > 0
    ) {
      continue;
    }

    return declaration;
  }

  return undefined;
}

function nodesOfType(root: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === type) found.push(node);
    if (node.type === 'doc_comment') return;

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return found;
}

function parseInteger(text: string): number {
  const normalized = text.replace(/_/g, '').replace(/[UuLl]+$/g, '');
  if (/^0[xX]/.test(normalized))
    return Number.parseInt(normalized.slice(2), 16);
  if (/^0[bB]/.test(normalized)) return Number.parseInt(normalized.slice(2), 2);
  if (/^0[oO]/.test(normalized)) return Number.parseInt(normalized.slice(2), 8);
  return Number.parseInt(normalized, 10);
}

function stringLiteralValue(text: string): string {
  if (text.startsWith('`') && text.endsWith('`'))
    return text.slice(1, -1).replace(/``/g, '`');

  const parts = text.match(/"([^"\\]|\\.)*"|`(``|[^`])*`/g);
  if (parts && parts.length > 1) {
    return parts.map(stringLiteralValue).join('');
  }

  return text
    .replace(/^"/, '')
    .replace(/"$/, '')
    .replace(/^`/, '')
    .replace(/`$/, '');
}

function comparable(left: ConstantValue, right: ConstantValue): boolean {
  return (
    (left.kind === 'int' || left.kind === 'float' || left.kind === 'string') &&
    left.kind === right.kind
  );
}

function comparableValue(value: ConstantValue): number | string {
  return value.kind === 'int' ||
    value.kind === 'float' ||
    value.kind === 'string'
    ? value.value
    : 0;
}

function bool(value: boolean): ConstantValue {
  return { kind: 'bool', typeName: 'bool', value };
}

function numberValue(typeName: string, value: number): ConstantValue {
  return Number.isInteger(value)
    ? { kind: 'int', typeName, value }
    : { kind: 'float', typeName: 'float', value };
}

function unknown(typeName?: string): ConstantValue {
  return { kind: 'unknown', typeName };
}

function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

const comparisonOperators = new Set(['==', '!=', '<', '<=', '>', '>=']);
