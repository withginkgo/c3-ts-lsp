import {
  MarkupKind,
  SymbolKind,
  type Hover,
  type Position,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE } from '../shared/builtin-types.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import { callArguments, callTargetFor } from '../shared/calls.js';
import { parseTypeRef } from '../shared/type-ref.js';
import type { C3Symbol, ResolveResult } from '../shared/types.js';

type HoverContext = {
  currentUri?: string;
  position?: Position;
};

const aggregateKinds = new Set<SymbolKind>([
  SymbolKind.Struct,
  SymbolKind.Enum,
  SymbolKind.Interface,
]);

export function hoverFromResolveResult(
  index: ProjectIndex,
  result: ResolveResult,
  context: HoverContext = {},
): Hover | null {
  if (result.selected) {
    return symbolHover(index, result.selected, context);
  }

  if (result.reason === 'ambiguous') {
    return ambiguousHover(result.candidates);
  }

  return null;
}

export function symbolHover(
  index: ProjectIndex,
  symbol: C3Symbol,
  context: HoverContext = {},
): Hover {
  const sections = [codeBlock(formatPrimarySymbol(index, symbol, context))];
  const owner = index.ownerSymbol(symbol);
  const typeSymbol = shouldShowValueType(symbol)
    ? index.typeSymbolFor(symbol)
    : undefined;

  const documentation =
    reflectionTagDocumentation(index, symbol, context) ?? symbol.documentation;

  if (documentation) {
    sections.push(documentation);
  }

  if (owner) {
    sections.push('member of:', codeBlock(formatAggregateSymbol(owner)));
  }

  if (
    typeSymbol &&
    !sameSymbol(typeSymbol, symbol) &&
    (!owner || !sameSymbol(typeSymbol, owner))
  ) {
    sections.push('type:', codeBlock(formatAggregateSymbol(typeSymbol)));
  }

  if (symbol.kind !== SymbolKind.Module) {
    sections.push(`module: \`${symbol.moduleName || '<unknown>'}\``);
  }

  const sourceKind = index.sourceKindForSymbol(symbol);
  if (sourceKind && sourceKind !== 'workspace') {
    sections.push(`source: \`${sourceKind}\``);
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: sections.join('\n\n'),
    },
  };
}

export function ambiguousHover(candidates: C3Symbol[]): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: [
        `Ambiguous symbol: ${candidates.length} candidates`,
        '',
        ...candidates.map(
          (symbol) =>
            `- \`${symbol.moduleName || '<unknown>'}\`: \`${symbol.signature}\``,
        ),
      ].join('\n'),
    },
  };
}

function reflectionTagDocumentation(
  index: ProjectIndex,
  symbol: C3Symbol,
  context: HoverContext,
): string | undefined {
  if (symbol.receiverType !== C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE) {
    return undefined;
  }

  if (symbol.name !== 'has_tag' && symbol.name !== 'get_tag') return undefined;
  if (!context.currentUri || !context.position) return undefined;

  const tagName = reflectionTagArgument(index, symbol, {
    currentUri: context.currentUri,
    position: context.position,
  });
  if (!tagName) return undefined;

  return symbol.name === 'has_tag'
    ? `Checks whether the current member has a compile-time custom attribute/tag named \`${tagName}\`.`
    : `Retrieves the compile-time tag value associated with \`${tagName}\`.`;
}

function reflectionTagArgument(
  index: ProjectIndex,
  symbol: C3Symbol,
  context: { currentUri: string; position: Position },
): string | undefined {
  const parsed = index.getParsed(context.currentUri);
  if (!parsed) return undefined;

  const node = parsed.tree.rootNode.descendantForPosition({
    row: context.position.line,
    column: context.position.character,
  });
  const call = ancestorOfType(node, 'call_expr');
  const functionNode = call?.childForFieldName('function');
  if (!call || !functionNode) return undefined;

  const target = callTargetFor(functionNode);
  if (target?.ref !== symbol.name) return undefined;

  const firstArg = callArguments(call)[0]?.node.namedChildren.find(
    (child) =>
      child.type === 'string_literal' ||
      child.type === 'raw_string_literal' ||
      child.type === 'string_expr',
  );

  return firstArg?.text.replace(/^"|"$/g, '').replace(/^`|`$/g, '');
}

function formatPrimarySymbol(
  index: ProjectIndex,
  symbol: C3Symbol,
  context: HoverContext,
): string {
  if (symbol.kind === SymbolKind.Module || symbol.symbolType === 'module') {
    return formatModuleSymbol(symbol);
  }

  if (isCallableSymbol(symbol)) {
    return formatFunctionSymbol(index, symbol, context);
  }

  if (symbol.typeInfo?.kind === 'fault-value') {
    return `fault value ${symbol.name}`;
  }

  return aggregateKinds.has(symbol.kind)
    ? formatAggregateSymbol(symbol)
    : symbol.signature;
}

function formatModuleSymbol(symbol: C3Symbol): string {
  const moduleName =
    symbol.moduleInfo?.canonicalName || symbol.moduleName || symbol.name;
  const genericParams =
    symbol.moduleInfo?.genericParams ?? symbol.moduleGenericParams ?? [];
  const suffix =
    genericParams.length > 0 ? ` <${genericParams.join(', ')}>` : '';

  return `module ${moduleName}${suffix}`;
}

function formatFunctionSymbol(
  index: ProjectIndex,
  symbol: C3Symbol,
  context: HoverContext,
): string {
  const substitution = functionGenericSubstitution(index, symbol, context);
  const params = (symbol.functionType?.params ?? callableParameters(symbol))
    .map((parameter) => substituteGenericParams(parameter.label, substitution))
    .join(', ');
  const receiver =
    symbol.kind === SymbolKind.Method && symbol.receiverType
      ? `${substituteGenericParams(symbol.receiverType, substitution)}.`
      : '';
  const returnType = instantiatedReturnType(symbol, substitution);
  const keyword = symbol.signature.startsWith('macro ') ? 'macro' : 'fn';

  return `${keyword} ${receiver}${symbol.name}(${params}) -> ${returnType}`;
}

function instantiatedReturnType(
  symbol: C3Symbol,
  substitution: FunctionGenericSubstitution,
): string {
  const rawReturnType =
    symbol.functionType?.returnType ?? symbol.returnType ?? 'void';
  const substituted = substituteGenericParams(rawReturnType, substitution.map);

  if (
    substitution.expectedReturnType &&
    shouldUseExpectedReturnType(rawReturnType, substituted, substitution)
  ) {
    return substitution.expectedReturnType;
  }

  return substituted;
}

type FunctionGenericSubstitution = {
  map: Map<string, string>;
  expectedReturnType?: string;
};

function functionGenericSubstitution(
  index: ProjectIndex,
  symbol: C3Symbol,
  context: HoverContext,
): FunctionGenericSubstitution {
  const genericParams = symbol.effectiveGenericParams ?? [];
  const callContext = callContextAtHover(index, context);
  const explicit = callContext?.genericArgs;

  if (explicit && explicit.length === genericParams.length) {
    return {
      map: new Map(
        genericParams.map((param, index) => [param, explicit[index] ?? param]),
      ),
      expectedReturnType: callContext?.expectedType,
    };
  }

  return {
    map: substitutionFromExpectedReturnType(symbol, callContext?.expectedType),
    expectedReturnType: callContext?.expectedType,
  };
}

function substitutionFromExpectedReturnType(
  symbol: C3Symbol,
  expectedType: string | undefined,
): Map<string, string> {
  const substitution = new Map<string, string>();
  const expected = parseTypeRef(expectedType);
  const returnType = parseTypeRef(
    symbol.functionType?.returnType ?? symbol.returnType,
  );
  if (!expected || !returnType || !sameNominalType(expected, returnType)) {
    return substitution;
  }

  const genericParams = new Set(symbol.effectiveGenericParams ?? []);

  if (returnType.arguments.length === expected.arguments.length) {
    for (let index = 0; index < returnType.arguments.length; index++) {
      const returnArg = returnType.arguments[index];
      const expectedArg = expected.arguments[index];
      if (
        !returnArg ||
        !expectedArg ||
        !genericParams.has(returnArg.normalized)
      ) {
        continue;
      }

      substitution.set(returnArg.normalized, expectedArg.source);
    }
  }

  if (
    substitution.size === 0 &&
    expected.arguments.length === (symbol.moduleGenericParams?.length ?? 0)
  ) {
    for (let index = 0; index < expected.arguments.length; index++) {
      const param = symbol.moduleGenericParams?.[index];
      const arg = expected.arguments[index];
      if (param && arg) substitution.set(param, arg.source);
    }
  }

  return substitution;
}

function shouldUseExpectedReturnType(
  rawReturnType: string,
  substitutedReturnType: string,
  substitution: FunctionGenericSubstitution,
): boolean {
  const expected = parseTypeRef(substitution.expectedReturnType);
  const raw = parseTypeRef(rawReturnType);
  const substituted = parseTypeRef(substitutedReturnType);
  if (!expected || !raw || !substituted || !sameNominalType(expected, raw)) {
    return false;
  }

  return expected.arguments.length > 0 && substituted.arguments.length === 0;
}

function sameNominalType(
  a: ReturnType<typeof parseTypeRef>,
  b: ReturnType<typeof parseTypeRef>,
): boolean {
  return !!a && !!b && (a.nominal === b.nominal || a.terminal === b.terminal);
}

function substituteGenericParams(
  text: string,
  substitution: Map<string, string> | FunctionGenericSubstitution,
): string {
  const map = substitution instanceof Map ? substitution : substitution.map;
  let result = text;

  for (const [param, replacement] of map) {
    const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(^|[^A-Za-z0-9_$@])${escaped}(?=$|[^A-Za-z0-9_$@])`, 'g'),
      `$1${replacement}`,
    );
  }

  return result;
}

function callContextAtHover(
  index: ProjectIndex,
  context: HoverContext,
): { expectedType?: string; genericArgs?: string[] } | undefined {
  if (!context.currentUri || !context.position) return undefined;

  const parsed = index.getParsed(context.currentUri);
  if (!parsed) return undefined;

  const node = parsed.tree.rootNode.descendantForPosition({
    row: context.position.line,
    column: context.position.character,
  });
  const call = ancestorOfType(node, 'call_expr');
  if (!call) return undefined;

  const functionNode = call.childForFieldName('function');
  const target = functionNode ? callTargetFor(functionNode) : null;

  return {
    expectedType: expectedTypeForExpression(index, parsed.uri, call),
    genericArgs: target?.genericArgs.map((arg) => arg.text),
  };
}

function expectedTypeForExpression(
  index: ProjectIndex,
  uri: string,
  expression: SyntaxNode,
): string | undefined {
  let current = expression;
  let parent = current.parent;

  while (parent && transparentExpressionTypes.has(parent.type)) {
    current = parent;
    parent = current.parent;
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
      return left
        ? index.typeNameForExpression(uri, left.text, rangeFromNode(left).start)
        : undefined;
    }
  }

  return undefined;
}

function formatAggregateSymbol(symbol: C3Symbol): string {
  if (!aggregateKinds.has(symbol.kind) || symbol.children.length === 0) {
    return symbol.signature;
  }

  return [
    `${symbol.signature} {`,
    ...symbol.children.map((child) => `    ${child.signature}`),
    '}',
  ].join('\n');
}

function codeBlock(value: string): string {
  return ['```c3', value, '```'].join('\n');
}

function sameSymbol(a: C3Symbol, b: C3Symbol): boolean {
  return (
    a.uri === b.uri &&
    a.selectionRange.start.line === b.selectionRange.start.line &&
    a.selectionRange.start.character === b.selectionRange.start.character &&
    a.selectionRange.end.line === b.selectionRange.end.line &&
    a.selectionRange.end.character === b.selectionRange.end.character
  );
}

function shouldShowValueType(symbol: C3Symbol): boolean {
  if (isCallableSymbol(symbol) || symbol.kind === SymbolKind.Module) {
    return false;
  }

  return !!(symbol.valueType ?? symbol.returnType);
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

function rangeFromNode(node: SyntaxNode) {
  return {
    start: {
      line: node.startPosition.row,
      character: node.startPosition.column,
    },
    end: {
      line: node.endPosition.row,
      character: node.endPosition.column,
    },
  };
}

function sameSyntaxNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

const transparentExpressionTypes = new Set([
  'paren_expr',
  'optional_expr',
  'rethrow_expr',
]);
