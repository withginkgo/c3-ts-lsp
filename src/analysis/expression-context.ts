import { SymbolKind, type Position } from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters } from '../shared/callable.js';
import {
  callArguments,
  callTargetFor,
  rangeFromNode,
} from '../shared/calls.js';
import type { ParsedDocument } from '../shared/types.js';
import {
  callArgumentShapeMatches,
  callableGenericArgumentMatches,
  instantiateCallableForCall,
  parameterIndexForTargetCallArgument,
} from './generic-call-inference.js';
import { callArgumentValueNode, expressionTypeName } from './type-analysis.js';

const transparentExpressionTypes = new Set([
  'paren_expr',
  'optional_expr',
  'rethrow_expr',
]);

export function expectedTypeForExpression(
  index: ProjectIndex,
  parsed: ParsedDocument,
  expression: SyntaxNode,
): string | undefined {
  let current = expression;
  let parent = current.parent;

  while (parent && transparentExpressionTypes.has(parent.type)) {
    current = parent;
    parent = current.parent;
  }

  if (parent?.type === 'typed_initializer_list') {
    const list = directChildOfType(parent, 'initializer_list');
    if (list && sameSyntaxNode(list, current)) {
      return parent.childForFieldName('type')?.text;
    }
  }

  if (parent?.type === 'declaration') {
    const right = parent.childForFieldName('right');
    if (right && sameSyntaxNode(right, current)) {
      return parent.childForFieldName('type')?.text;
    }
  }

  if (parent?.type === 'assignment_expr') {
    const right =
      parent.childForFieldName('right') ?? parent.namedChildren.at(-1);
    if (right && sameSyntaxNode(right, current)) {
      const left = parent.childForFieldName('left') ?? parent.namedChildren[0];
      return left ? expressionTypeName(index, parsed, left) : undefined;
    }
  }

  if (parent?.type === 'return_stmt') {
    const returned = returnExpression(parent);
    if (returned && sameSyntaxNode(returned, current)) {
      return enclosingCallableReturnType(parent);
    }
  }

  if (parent?.type === 'initializer_element') {
    return initializerElementValueExpectedType(index, parsed, parent, current);
  }

  if (parent?.type === 'call_arg') {
    const value = callArgumentValueNode(parent);
    if (value && sameSyntaxNode(value, current)) {
      return callArgumentExpectedType(index, parsed, parent);
    }
  }

  return undefined;
}

function initializerElementValueExpectedType(
  index: ProjectIndex,
  parsed: ParsedDocument,
  element: SyntaxNode,
  value: SyntaxNode,
): string | undefined {
  const valueNode = element.namedChildren.at(-1);
  if (!valueNode || !sameSyntaxNode(valueNode, value)) return undefined;

  const fieldName = initializerElementFieldName(element);
  if (!fieldName) return undefined;

  const list = ancestorOfType(element, 'initializer_list');
  if (!list) return undefined;

  const typeName = expectedTypeForExpression(index, parsed, list);
  if (!typeName) return undefined;

  return index
    .memberSymbolsForType(parsed.uri, typeName, rangeFromNode(element).start)
    .find(
      (symbol) => symbol.kind === SymbolKind.Field && symbol.name === fieldName,
    )?.returnType;
}

function initializerElementFieldName(element: SyntaxNode): string | undefined {
  const paramPath = directChildOfType(element, 'param_path');
  const field = paramPath
    ?.descendantsOfType('param_path_element')
    .at(-1)
    ?.childForFieldName('field');

  return field?.text;
}

function callArgumentExpectedType(
  index: ProjectIndex,
  parsed: ParsedDocument,
  callArg: SyntaxNode,
): string | undefined {
  const call = ancestorOfType(callArg, 'call_expr');
  if (!call) return undefined;

  const args = callArguments(call);
  const arg = args.find((candidate) => sameSyntaxNode(candidate.node, callArg));
  if (!arg) return undefined;

  const functionNode = call.childForFieldName('function');
  if (!functionNode) return undefined;

  const target = callTargetFor(functionNode);
  if (!target) return undefined;

  const result = index.resolveCallableSymbol(
    parsed.uri,
    target.ref,
    target.position,
  );
  const candidates = callableGenericArgumentMatches(result.candidates, target);
  const selected =
    candidates.find((symbol) =>
      callArgumentShapeMatches(
        callableParameters(symbol, { methodStyle: target.methodStyle }),
        args,
      ),
    ) ?? candidates[0];
  if (!selected) return undefined;

  const instantiated = instantiateCallableForCall(
    selected,
    index,
    parsed,
    target,
    args,
    expectedTypeForExpression(index, parsed, call),
  );
  const parameterIndex = parameterIndexForTargetCallArgument(
    instantiated.parameters,
    args,
    arg,
  );

  return parameterIndex === undefined
    ? undefined
    : instantiated.parameters[parameterIndex]?.type;
}

function returnExpression(statement: SyntaxNode): SyntaxNode | undefined {
  return statement.namedChildren.find((child) => !child.isMissing);
}

function enclosingCallableReturnType(node: SyntaxNode): string | undefined {
  const callable =
    ancestorOfType(node, 'func_definition') ??
    ancestorOfType(node, 'macro_declaration');
  const header = callable
    ? (directChildOfType(callable, 'func_header') ??
      directChildOfType(callable, 'macro_header'))
    : undefined;

  return header?.childForFieldName('return_type')?.text;
}

function ancestorOfType(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | undefined {
  let current = node;

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

function sameSyntaxNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

export function initializerListAtPosition(
  root: SyntaxNode,
  position: Position,
): SyntaxNode | undefined {
  const node = root.descendantForPosition({
    row: position.line,
    column: Math.max(0, position.character - 1),
  });

  return ancestorOfType(node, 'initializer_list');
}
