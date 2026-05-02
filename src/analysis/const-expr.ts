import { SymbolKind } from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callTargetFor } from '../shared/calls.js';
import { normalizeTypeName, terminalTypeName } from '../shared/type-ref.js';
import type { C3Symbol, ParsedDocument } from '../shared/types.js';
import { rangeFromNode } from './type-analysis.js';

export type ConstExprKind =
  | { kind: 'const' }
  | { kind: 'not_const'; reason: string }
  | { kind: 'unknown'; reason: string };

export type GlobalInitExprKind =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unknown'; reason: string };

export type ConstExprContext = {
  index: ProjectIndex;
  parsed: ParsedDocument;
  visitedConstSymbols?: Set<string>;
};

const constExpr: ConstExprKind = { kind: 'const' };
const validGlobalInitExpr: GlobalInitExprKind = { kind: 'valid' };

const allowedUnaryConstOperators = new Set(['+', '-', '!', '~']);
const allowedBinaryConstOperators = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '<<',
  '>>',
  '&',
  '|',
  '^',
  '&&',
  '||',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
]);

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

export function checkConstExpr(
  expression: SyntaxNode,
  context: ConstExprContext,
): ConstExprKind {
  return checkConstExprNode(expression, {
    ...context,
    visitedConstSymbols: context.visitedConstSymbols ?? new Set(),
  });
}

export function checkGlobalInitExpr(
  expression: SyntaxNode,
  expectedType: string | undefined,
  context: ConstExprContext,
): GlobalInitExprKind {
  return checkGlobalInitExprNode(expression, expectedType, {
    ...context,
    visitedConstSymbols: context.visitedConstSymbols ?? new Set(),
  });
}

function checkConstExprNode(
  expression: SyntaxNode,
  context: Required<ConstExprContext>,
): ConstExprKind {
  switch (expression.type) {
    case 'null':
    case 'true':
    case 'false':
    case 'boolean_literal':
    case 'integer_literal':
    case 'real_literal':
    case 'char_literal':
    case 'string_literal':
      return constExpr;

    case 'paren_expr': {
      const inner = expression.namedChildren[0];
      return inner
        ? checkConstExprNode(inner, context)
        : unknown('parenthesized expression has no inner expression');
    }

    case 'unary_expr':
      return checkUnaryConstExpr(expression, context);

    case 'binary_expr':
      return checkBinaryConstExpr(expression, context);

    case 'cast_expr':
      return checkCastConstExpr(expression, context);

    case 'ident_expr':
      return checkIdentifierConstExpr(expression, context);

    case 'call_expr':
      return checkCallConstExpr(expression, context);

    case 'initializer_list':
    case 'typed_initializer_list':
    case 'type':
    case 'generic_type_ident':
    case 'trailing_generic_expr':
      return notConst('compound literals are not constant expressions');

    case 'field_expr':
    case 'subscript_expr':
    case 'optional_expr':
    case 'rethrow_expr':
    case 'lambda_expr':
      return notConst(`${expression.type} is not a constant expression`);

    default:
      return unknown(
        `constant expression support for ${expression.type} is not implemented`,
      );
  }
}

function checkUnaryConstExpr(
  expression: SyntaxNode,
  context: Required<ConstExprContext>,
): ConstExprKind {
  const operator = expressionOperator(expression);
  if (!operator) return unknown('unary expression has no operator');

  if (!allowedUnaryConstOperators.has(operator)) {
    return notConst(
      `unary operator '${operator}' is not allowed in constant expressions`,
    );
  }

  const operand = expression.childForFieldName('argument');
  if (!operand) return unknown('unary expression has no operand');

  return checkConstExprNode(operand, context);
}

function checkBinaryConstExpr(
  expression: SyntaxNode,
  context: Required<ConstExprContext>,
): ConstExprKind {
  const operator = expressionOperator(expression);
  if (!operator) return unknown('binary expression has no operator');

  if (!allowedBinaryConstOperators.has(operator)) {
    return notConst(
      `binary operator '${operator}' is not allowed in constant expressions`,
    );
  }

  const left = expression.childForFieldName('left');
  const right = expression.childForFieldName('right');
  if (!left || !right) return unknown('binary expression is incomplete');

  return combineConstExprResults(
    checkConstExprNode(left, context),
    checkConstExprNode(right, context),
  );
}

function checkCastConstExpr(
  expression: SyntaxNode,
  context: Required<ConstExprContext>,
): ConstExprKind {
  const typeNode = expression.childForFieldName('type');
  const valueNode =
    expression.childForFieldName('value') ??
    expression.namedChildren.find(
      (child) => child.startIndex !== typeNode?.startIndex,
    );

  if (!typeNode || !valueNode) return unknown('cast expression is incomplete');

  if (!isConstantCastTargetType(typeNode.text)) {
    return notConst(
      'only bool, integer, and floating-point casts are constant expressions',
    );
  }

  return checkConstExprNode(valueNode, context);
}

function checkIdentifierConstExpr(
  expression: SyntaxNode,
  context: Required<ConstExprContext>,
): ConstExprKind {
  if (isCompileTimeIdentifier(expression)) return constExpr;

  const resolved = context.index.resolveSymbol(
    context.parsed.uri,
    expression.text,
    rangeFromNode(expression).start,
  ).selected;

  if (!resolved)
    return unknown(`unresolved constant reference '${expression.text}'`);

  if (resolved.kind !== SymbolKind.Constant) {
    return notConst(`'${expression.text}' is not a constant`);
  }

  return checkResolvedConstant(resolved, context);
}

function checkCallConstExpr(
  expression: SyntaxNode,
  context: Required<ConstExprContext>,
): ConstExprKind {
  const functionNode = expression.childForFieldName('function');
  const target = functionNode ? callTargetFor(functionNode) : undefined;

  if (target) {
    const resolved = context.index.resolveCallableSymbol(
      context.parsed.uri,
      target.ref,
      target.position,
    ).selected;

    if (
      target.ref.startsWith('@') ||
      resolved?.signature.startsWith('macro ')
    ) {
      // TODO: Model macro constant expressions that expand without generating
      // runtime code and only consume constant-expression inputs.
      return unknown('macro constant expression analysis is not implemented');
    }
  }

  return notConst('function calls are not constant expressions');
}

function checkGlobalInitExprNode(
  expression: SyntaxNode,
  expectedType: string | undefined,
  context: Required<ConstExprContext>,
): GlobalInitExprKind {
  const constResult = checkConstExprNode(expression, context);
  if (constResult.kind === 'const') return validGlobalInitExpr;

  switch (expression.type) {
    case 'paren_expr': {
      const inner = expression.namedChildren[0];
      return inner
        ? checkGlobalInitExprNode(inner, expectedType, context)
        : unknownGlobalInit('parenthesized expression has no inner expression');
    }

    case 'typed_initializer_list': {
      const typeNode = expression.childForFieldName('type');
      const initializerList = directChildOfType(expression, 'initializer_list');
      return initializerList
        ? checkInitializerListGlobalInitExpr(
            initializerList,
            typeNode?.text ?? expectedType,
            context,
          )
        : unknownGlobalInit('typed initializer has no initializer list');
    }

    case 'initializer_list':
      return checkInitializerListGlobalInitExpr(
        expression,
        expectedType,
        context,
      );

    case 'cast_expr': {
      const aggregateList = castInitializerList(expression);
      if (aggregateList) {
        const typeNode = expression.childForFieldName('type');
        return checkInitializerListGlobalInitExpr(
          aggregateList,
          typeNode?.text ?? expectedType,
          context,
        );
      }

      return constResult.kind === 'unknown'
        ? unknownGlobalInit(constResult.reason)
        : invalidGlobalInit(constResult.reason);
    }

    case 'call_expr':
      return constResult.kind === 'unknown'
        ? unknownGlobalInit(constResult.reason)
        : invalidGlobalInit('function calls require runtime execution');

    case 'ident_expr':
    case 'unary_expr':
    case 'binary_expr':
    case 'field_expr':
    case 'subscript_expr':
    case 'optional_expr':
    case 'rethrow_expr':
    case 'lambda_expr':
      return constResult.kind === 'unknown'
        ? unknownGlobalInit(constResult.reason)
        : invalidGlobalInit(constResult.reason);

    default:
      return constResult.kind === 'unknown'
        ? unknownGlobalInit(constResult.reason)
        : invalidGlobalInit(constResult.reason);
  }
}

function checkInitializerListGlobalInitExpr(
  initializerList: SyntaxNode,
  expectedType: string | undefined,
  context: Required<ConstExprContext>,
): GlobalInitExprKind {
  let firstUnknown: GlobalInitExprKind | undefined;

  for (const element of initializerList.namedChildren) {
    if (element.type !== 'initializer_element') continue;

    const value = initializerElementValueNode(element);
    if (!value) continue;

    const result = checkGlobalInitExprNode(value, expectedType, context);
    if (result.kind === 'invalid') return result;
    if (result.kind === 'unknown' && !firstUnknown) firstUnknown = result;
  }

  // TODO: Split global init expression from pure constant expression further.
  // C3 permits additional static-layout forms such as some address constants
  // and has stricter rules around self-references; those require type-aware
  // initializer evaluation rather than this syntactic aggregate walk.
  return firstUnknown ?? validGlobalInitExpr;
}

function checkResolvedConstant(
  symbol: C3Symbol,
  context: Required<ConstExprContext>,
): ConstExprKind {
  const key = constSymbolKey(symbol);
  if (context.visitedConstSymbols.has(key)) {
    return unknown(`recursive constant reference '${symbol.name}'`);
  }

  const parsed = context.index.getParsed(symbol.uri);
  if (!parsed)
    return unknown(`constant '${symbol.name}' source is not indexed`);

  const declaration = constDeclarationForSymbol(parsed, symbol);
  if (!declaration) {
    return unknown(
      `constant '${symbol.name}' has no initializer in the indexed source`,
    );
  }

  const initializer = declaration.childForFieldName('right');
  if (!initializer)
    return unknown(`constant '${symbol.name}' has no initializer`);

  context.visitedConstSymbols.add(key);
  const result = checkConstExprNode(initializer, {
    ...context,
    parsed,
  });
  context.visitedConstSymbols.delete(key);

  return result;
}

function combineConstExprResults(
  left: ConstExprKind,
  right: ConstExprKind,
): ConstExprKind {
  if (left.kind === 'not_const') return left;
  if (right.kind === 'not_const') return right;
  if (left.kind === 'unknown') return left;
  if (right.kind === 'unknown') return right;

  return constExpr;
}

function expressionOperator(expression: SyntaxNode): string | undefined {
  for (let index = 0; index < expression.childCount; index++) {
    const child = expression.child(index);
    if (!child?.isNamed) return child?.text;
  }

  return undefined;
}

function isConstantCastTargetType(typeName: string): boolean {
  const normalized = normalizeTypeName(typeName);
  const terminal = terminalTypeName(normalized);

  return (
    terminal === 'bool' ||
    integerTypeNames.has(terminal) ||
    realTypeNames.has(terminal)
  );
}

function isCompileTimeIdentifier(expression: SyntaxNode): boolean {
  return (
    expression.text.trim().startsWith('$') ||
    expression.namedChildren.some((child) => child.type === 'ct_ident')
  );
}

function constDeclarationForSymbol(
  parsed: ParsedDocument,
  symbol: C3Symbol,
): SyntaxNode | undefined {
  for (const declaration of nodesOfType(
    parsed.tree.rootNode,
    'const_declaration',
  )) {
    const name = declaration.childForFieldName('name');
    if (!name) continue;

    const range = rangeFromNode(name);
    if (
      range.start.line === symbol.selectionRange.start.line &&
      range.start.character === symbol.selectionRange.start.character &&
      range.end.line === symbol.selectionRange.end.line &&
      range.end.character === symbol.selectionRange.end.character
    ) {
      return declaration;
    }
  }

  return undefined;
}

function nodesOfType(root: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'doc_comment') return;
    if (node.type === type) found.push(node);

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return found;
}

function constSymbolKey(symbol: C3Symbol): string {
  return [
    symbol.uri,
    symbol.moduleName,
    symbol.name,
    symbol.selectionRange.start.line,
    symbol.selectionRange.start.character,
  ].join(':');
}

function notConst(reason: string): ConstExprKind {
  return { kind: 'not_const', reason };
}

function unknown(reason: string): ConstExprKind {
  return { kind: 'unknown', reason };
}

function invalidGlobalInit(reason: string): GlobalInitExprKind {
  return { kind: 'invalid', reason };
}

function unknownGlobalInit(reason: string): GlobalInitExprKind {
  return { kind: 'unknown', reason };
}

function castInitializerList(expression: SyntaxNode): SyntaxNode | undefined {
  const value = expression.childForFieldName('value');
  if (value?.type === 'initializer_list') return value;

  return directChildOfType(expression, 'initializer_list');
}

function initializerElementValueNode(
  element: SyntaxNode,
): SyntaxNode | undefined {
  const right = element.childForFieldName('right');
  if (right) return right;

  for (let index = element.childCount - 1; index >= 0; index--) {
    const child = element.child(index);
    if (!child || !isInitializerValueNode(child)) continue;

    return child;
  }

  return undefined;
}

function isInitializerValueNode(node: SyntaxNode): boolean {
  if (node.type === 'param_path') return false;
  if (['=', ',', '{', '}'].includes(node.type)) return false;

  return node.isNamed || isLiteralToken(node);
}

function isLiteralToken(node: SyntaxNode): boolean {
  return ['null', 'true', 'false'].includes(node.type);
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

// TODO: Model macro constant expressions that expand without generating
// runtime code and only consume constant-expression inputs.
// TODO: Extend global initializer analysis with the C3-only differences from
// ordinary constant expressions, including valid address constants,
// address-of self-reference rules, and type-aware validation of aggregate
// initializers.
