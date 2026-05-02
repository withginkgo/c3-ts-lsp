import {
  CompletionItemKind,
  InsertTextFormat,
  SymbolKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { SyntaxNode } from 'tree-sitter';

import {
  callArgumentValueNode,
  expressionTypeName,
} from '../analysis/type-analysis.js';
import { parseSource } from '../parser/c3-parser.js';
import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  callArguments,
  callTargetFor,
  rangeFromNode,
  type C3CallArgument,
} from '../shared/calls.js';
import {
  C3_BUILTIN_ATTRIBUTES,
  C3_COMPILE_TIME_BUILTINS,
  C3_DEFINED_CONSTANTS,
  C3_KEYWORDS,
} from '../shared/language-data.js';
import {
  parseTypeRef,
  typeNamesCompatible,
  type C3TypeRef,
} from '../shared/type-ref.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';
import {
  attributeCompletionBeforeCursor,
  callArgumentContextBeforeCursor,
  dotAccessCompletionBeforeCursor,
  identifierCompletionBeforeCursor,
  memberAccessBeforeCursor,
  methodContext,
  modulePathCompletionBeforeCursor,
  modulePrefixBeforeCursor,
  namedArgumentsBeforeCursor,
  structInitializerFieldBeforeCursor,
  type AttributeCompletionContext,
  type CallArgumentContext,
  type IdentifierCompletionContext,
  type ModulePathCompletionContext,
  type StructInitializerFieldCompletionContext,
  typeMethodDeclarationBeforeCursor,
} from './completion-context.js';
import { contractCompletionItems } from './contracts.js';
import { importTextEdit } from './import-edits.js';

const MAX_AUTO_IMPORT_COMPLETIONS = 200;
const TRIGGER_PARAMETER_HINTS_COMMAND = 'editor.action.triggerParameterHints';

export function completionItems(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): CompletionItem[] {
  if (!doc || !current) return keywordCompletions();

  const contractItems = contractCompletionItems(index, doc, current, position);
  if (contractItems) return contractItems;

  const modulePathCompletion = modulePathCompletionBeforeCursor(doc, position);

  if (modulePathCompletion) {
    return modulePathCompletions(index, current, modulePathCompletion);
  }

  const attributeCompletion = attributeCompletionBeforeCursor(doc, position);

  if (attributeCompletion) {
    return attributeCompletions(index, current, position, attributeCompletion);
  }

  const typeMethodDeclaration = typeMethodDeclarationBeforeCursor(
    doc,
    position,
  );

  if (typeMethodDeclaration) {
    return methodCompletionsForType(
      index,
      current,
      typeMethodDeclaration.receiver,
      typeMethodDeclaration.position,
    );
  }

  const memberAccess = memberAccessBeforeCursor(doc, position);

  if (memberAccess) {
    return memberCompletions(
      index,
      current,
      memberAccess.receiver,
      memberAccess.position,
    );
  }

  const structInitializerField = structInitializerFieldBeforeCursor(
    doc,
    position,
  );

  if (structInitializerField) {
    return structInitializerFieldCompletions(
      index,
      current,
      position,
      structInitializerField,
    );
  }

  if (dotAccessCompletionBeforeCursor(doc, position)) {
    return [];
  }

  const prefix = modulePrefixBeforeCursor(doc, position);

  if (prefix) {
    return moduleMemberCompletions(index, current, prefix);
  }

  const identifierCompletion = identifierCompletionBeforeCursor(doc, position);
  const argumentItems = argumentNameCompletions(index, doc, current, position);
  const visibleSymbols = index
    .visibleSymbolsAt(current.uri, position)
    .filter((symbol) =>
      completionLabelMatchesPrefix(symbol.name, identifierCompletion.prefix),
    );
  const visibleNames = new Set(visibleSymbols.map((symbol) => symbol.name));

  const symbolItems = visibleSymbols.map((symbol) =>
    identifierCompletionItem(
      symbolCompletionItem(symbol),
      identifierCompletion,
    ),
  );
  const autoImportItems =
    identifierCompletion.prefix.length > 0
      ? index
          .autoImportCandidates(current, identifierCompletion.prefix)
          .slice(0, MAX_AUTO_IMPORT_COMPLETIONS)
          .filter(({ symbol }) => !visibleNames.has(symbol.name))
          .map(({ moduleName, symbol }) =>
            identifierCompletionItem(
              autoImportCompletionItem(current, moduleName, symbol),
              identifierCompletion,
            ),
          )
      : [];

  return [
    ...argumentItems,
    ...keywordCompletions(identifierCompletion),
    ...symbolItems,
    ...autoImportItems,
  ];
}

function attributeCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: AttributeCompletionContext,
): CompletionItem[] {
  return uniqueCompletionItems([
    ...C3_BUILTIN_ATTRIBUTES.filter((attribute) =>
      attributeMatchesPrefix(attribute, context.prefix),
    ).map((attribute) => attributeCompletionItem(attribute, context)),
    ...index
      .visibleSymbolsAt(current.uri, position)
      .filter(
        (symbol) =>
          symbol.kind === SymbolKind.Property &&
          symbol.name.startsWith('@') &&
          attributeMatchesPrefix(symbol.name, context.prefix),
      )
      .map((symbol) =>
        attributeCompletionItem(symbol.name, context, symbol.signature),
      ),
  ]);
}

function attributeMatchesPrefix(attribute: string, prefix: string): boolean {
  const name = attributeName(attribute);

  return (
    prefix.length === 0 ||
    attribute.startsWith(`@${prefix}`) ||
    name.startsWith(prefix)
  );
}

function attributeCompletionItem(
  attribute: string,
  context: AttributeCompletionContext,
  detail?: string,
): CompletionItem {
  const name = attributeName(attribute);

  return {
    label: attribute,
    kind: CompletionItemKind.Property,
    detail,
    filterText: name,
    textEdit: {
      range: context.replaceRange,
      newText: name,
    },
  };
}

function attributeName(attribute: string): string {
  return attribute.startsWith('@') ? attribute.slice(1) : attribute;
}

function argumentNameCompletions(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument,
  position: Position,
): CompletionItem[] {
  const context = callArgumentContextBeforeCursor(doc, position);
  if (!context) return [];

  const callable = callableForContext(index, current, context);
  if (!callable) return [];

  const supplied = namedArgumentsBeforeCursor(context.argumentsText);

  return callableParameters(callable.symbol, {
    methodStyle: callable.methodStyle,
  })
    .filter((parameter) => parameter.name && !supplied.has(parameter.name))
    .map((parameter) => ({
      label: parameter.name!,
      kind: CompletionItemKind.Variable,
      detail: parameter.label,
      insertText: `${parameter.name}: `,
    }));
}

function callableForContext(
  index: ProjectIndex,
  current: ParsedDocument,
  context: CallArgumentContext,
): { symbol: C3Symbol; methodStyle: boolean } | null {
  const method = methodContext(context.callee);

  if (method) {
    const symbol = index
      .memberSymbolsForExpression(
        current.uri,
        method.receiver,
        context.calleePosition,
      )
      .find((candidate) => candidate.name === method.name);

    return symbol && isCallableSymbol(symbol)
      ? { symbol, methodStyle: true }
      : null;
  }

  const result = index.resolveCallableSymbol(
    current.uri,
    context.callee,
    context.calleePosition,
  );
  const symbol = result.selected;

  return symbol && isCallableSymbol(symbol)
    ? { symbol, methodStyle: false }
    : null;
}

function keywordCompletions(
  context?: IdentifierCompletionContext,
): CompletionItem[] {
  return [
    ...C3_KEYWORDS.map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Keyword,
    })),
    ...C3_BUILTIN_ATTRIBUTES.map((attribute) => ({
      label: attribute,
      kind: CompletionItemKind.Property,
    })),
    ...C3_DEFINED_CONSTANTS.map((constant) => ({
      label: constant,
      kind: CompletionItemKind.Constant,
    })),
    ...C3_COMPILE_TIME_BUILTINS.map((builtin) => ({
      label: builtin,
      kind: CompletionItemKind.Function,
    })),
  ]
    .filter((item) =>
      completionLabelMatchesPrefix(String(item.label), context?.prefix ?? ''),
    )
    .map((item) => identifierCompletionItem(item, context));
}

function memberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  receiver: string,
  position: Position,
): CompletionItem[] {
  return index
    .memberSymbolsForExpression(current.uri, receiver, position)
    .map((symbol) => memberCompletionItem(symbol));
}

function memberCompletionItem(symbol: C3Symbol): CompletionItem {
  const item: CompletionItem = {
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  };

  if (symbol.kind === SymbolKind.Method) {
    item.insertText = `${symbol.name}($0)`;
    item.insertTextFormat = InsertTextFormat.Snippet;
    item.command = {
      title: 'Trigger Parameter Hints',
      command: TRIGGER_PARAMETER_HINTS_COMMAND,
    };
  }

  return item;
}

function structInitializerFieldCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: StructInitializerFieldCompletionContext,
): CompletionItem[] {
  const typeName =
    context.typeName ??
    expectedInitializerTypeName(index, current, position, context);
  if (!typeName) return [];

  return index
    .memberSymbolsForType(current.uri, typeName, position)
    .filter(
      (symbol) =>
        symbol.kind === SymbolKind.Field &&
        symbol.name.startsWith(context.prefix),
    )
    .map((symbol) => ({
      ...memberCompletionItem(symbol),
      label: `.${symbol.name}`,
      filterText: symbol.name,
      sortText: `!${symbol.name}`,
      textEdit: {
        range: context.replaceRange,
        newText: `.${symbol.name}`,
      },
    }));
}

function expectedInitializerTypeName(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: StructInitializerFieldCompletionContext,
): string | undefined {
  const initializer = initializerListAtPosition(
    current.tree.rootNode,
    position,
  );
  if (!initializer) {
    return expectedInitializerTypeNameFromRepairedDesignator(
      index,
      current,
      position,
      context,
    );
  }

  const parent = initializer.parent;
  if (!parent) return undefined;

  if (parent.type === 'typed_initializer_list') {
    return parent.childForFieldName('type')?.text;
  }

  return expectedExpressionTypeName(index, current, initializer);
}

function expectedInitializerTypeNameFromRepairedDesignator(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: StructInitializerFieldCompletionContext,
): string | undefined {
  const start = offsetAtPosition(current.source, context.replaceRange.start);
  const end = offsetAtPosition(current.source, position);
  if (start == null || end == null || start > end) return undefined;

  const placeholder = '.__c3_lsp_field';
  const source = `${current.source.slice(0, start)}${placeholder}${current.source.slice(end)}`;
  const repairedPosition = positionAtOffset(source, start + placeholder.length);
  const repaired = parseSource(current.uri, source, {
    sourceKind: current.sourceKind,
  });
  const initializer = initializerListAtPosition(
    repaired.tree.rootNode,
    repairedPosition,
  );

  return initializer
    ? expectedExpressionTypeName(index, repaired, initializer)
    : undefined;
}

function expectedExpressionTypeName(
  index: ProjectIndex,
  current: ParsedDocument,
  expression: SyntaxNode,
): string | undefined {
  let node = expression;
  let parent = node.parent;

  while (parent && transparentExpressionTypes.has(parent.type)) {
    node = parent;
    parent = node.parent;
  }

  if (parent?.type === 'typed_initializer_list') {
    const list = directChildOfType(parent, 'initializer_list');
    if (list && sameSyntaxNode(list, node)) {
      return parent.childForFieldName('type')?.text;
    }
  }

  if (parent?.type === 'declaration') {
    const right = parent.childForFieldName('right');
    if (!right || !sameSyntaxNode(right, node)) return undefined;

    return parent.childForFieldName('type')?.text;
  }

  if (parent?.type === 'assignment_expr') {
    const right =
      parent.childForFieldName('right') ?? parent.namedChildren.at(-1);
    if (!right || !sameSyntaxNode(right, node)) return undefined;

    const left = parent.childForFieldName('left') ?? parent.namedChildren[0];
    return left ? expressionTypeName(index, current, left) : undefined;
  }

  if (parent?.type === 'return_stmt') {
    const returned = returnExpression(parent);
    if (returned && sameSyntaxNode(returned, node)) {
      return enclosingCallableReturnType(parent);
    }
  }

  if (parent?.type === 'initializer_element') {
    return initializerElementValueExpectedType(index, current, parent, node);
  }

  if (parent?.type === 'call_arg') {
    const value = callArgumentValueNode(parent);
    if (value && sameSyntaxNode(value, node)) {
      return callArgumentExpectedType(index, current, parent);
    }
  }

  return undefined;
}

function initializerElementValueExpectedType(
  index: ProjectIndex,
  current: ParsedDocument,
  element: SyntaxNode,
  value: SyntaxNode,
): string | undefined {
  const valueNode = element.namedChildren.at(-1);
  if (!valueNode || !sameSyntaxNode(valueNode, value)) return undefined;

  const fieldName = initializerElementFieldName(element);
  if (!fieldName) return undefined;

  const list = ancestorOfType(element, 'initializer_list');
  if (!list) return undefined;

  const typeName = expectedExpressionTypeName(index, current, list);
  if (!typeName) return undefined;

  return index
    .memberSymbolsForType(current.uri, typeName, rangeFromNode(element).start)
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
  current: ParsedDocument,
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
    current.uri,
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

  const parameters = instantiateCallableParameters(
    selected,
    index,
    current,
    target.methodStyle,
    target.genericArgs.map((genericArg) => genericArg.text),
    target.genericRange !== undefined,
    args,
    expectedExpressionTypeName(index, current, call),
  );
  const parameterIndex = parameterIndexForCallArgument(parameters, args, arg);

  return parameterIndex === undefined
    ? undefined
    : parameters[parameterIndex]?.type;
}

function callableGenericArgumentMatches(
  candidates: C3Symbol[],
  target: { genericArgs: SyntaxNode[]; genericRange?: unknown },
): C3Symbol[] {
  if (!target.genericRange) return candidates;

  return candidates.filter(
    (symbol) =>
      genericParameterCountForSymbol(symbol) === target.genericArgs.length,
  );
}

function instantiateCallableParameters(
  symbol: C3Symbol,
  index: ProjectIndex,
  current: ParsedDocument,
  methodStyle: boolean,
  explicitGenericArgs: string[],
  hasExplicitGenericArgs: boolean,
  args: C3CallArgument[],
  expectedReturnType: string | undefined,
): C3Parameter[] {
  const parameters = callableParameters(symbol, { methodStyle });
  const genericParams = symbol.effectiveGenericParams ?? [];
  if (genericParams.length === 0) return parameters;

  const genericParamSet = new Set(genericParams);
  const substitution = new Map<string, string>();

  if (
    hasExplicitGenericArgs &&
    explicitGenericArgs.length === genericParams.length
  ) {
    for (let index = 0; index < genericParams.length; index++) {
      substitution.set(genericParams[index]!, explicitGenericArgs[index]!);
    }
  } else {
    collectGenericConstraintsFromExpectedReturnType(
      symbol,
      expectedReturnType,
      genericParamSet,
      substitution,
    );
    collectGenericConstraintsFromArguments(
      index,
      current,
      parameters,
      args,
      genericParamSet,
      substitution,
    );
  }

  return parameters.map((parameter) => ({
    ...parameter,
    label: substituteGenericParams(parameter.label, substitution),
    type: parameter.type
      ? substituteGenericParams(parameter.type, substitution)
      : undefined,
  }));
}

function collectGenericConstraintsFromExpectedReturnType(
  symbol: C3Symbol,
  expectedType: string | undefined,
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  const returnType = symbol.functionType?.returnType ?? symbol.returnType;
  if (!returnType || !expectedType) return;

  const expected = parseTypeRef(expectedType);
  const actual = parseTypeRef(returnType);
  if (!expected || !actual || !sameNominalType(actual, expected)) return;

  unifyTypeRefs(actual, expected, genericParams, substitution);

  if (
    actual.arguments.length === 0 &&
    expected.arguments.length === (symbol.moduleGenericParams?.length ?? 0)
  ) {
    for (let index = 0; index < expected.arguments.length; index++) {
      const param = symbol.moduleGenericParams?.[index];
      const arg = expected.arguments[index];
      if (param && arg && genericParams.has(param)) {
        bindGenericParam(param, arg.source, substitution);
      }
    }
  }
}

function collectGenericConstraintsFromArguments(
  index: ProjectIndex,
  current: ParsedDocument,
  parameters: C3Parameter[],
  args: C3CallArgument[],
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = parameterIndexForCallArgumentWithCursor(
      parameters,
      arg,
      supplied,
      positionalCursor,
      variadicIndex,
    );
    if (parameterIndex === undefined) continue;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;

    const parameter = parameters[parameterIndex];
    const value = callArgumentValueNode(arg.node);
    if (!parameter?.type || !value) continue;

    const actualType = expressionTypeName(index, current, value);
    if (!actualType) continue;

    unifyTypeNames(parameter.type, actualType, genericParams, substitution);
  }
}

function parameterIndexForCallArgument(
  parameters: C3Parameter[],
  args: C3CallArgument[],
  targetArg: C3CallArgument,
): number | undefined {
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = parameterIndexForCallArgumentWithCursor(
      parameters,
      arg,
      supplied,
      positionalCursor,
      variadicIndex,
    );
    if (parameterIndex === undefined) return undefined;
    if (sameSyntaxNode(arg.node, targetArg.node)) return parameterIndex;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;
  }

  return undefined;
}

function parameterIndexForCallArgumentWithCursor(
  parameters: C3Parameter[],
  arg: C3CallArgument,
  supplied: Set<number>,
  positionalCursor: number,
  variadicIndex: number,
): number | undefined {
  if (arg.name) {
    const namedIndex = parameters.findIndex(
      (parameter) => parameter.name === arg.name,
    );
    return namedIndex >= 0 && !supplied.has(namedIndex)
      ? namedIndex
      : undefined;
  }

  const positionalIndex = nextPositionalIndex(
    parameters,
    supplied,
    positionalCursor,
    variadicIndex,
  );

  if (variadicIndex >= 0 && positionalIndex >= variadicIndex) {
    return variadicIndex;
  }

  return positionalIndex < parameters.length ? positionalIndex : undefined;
}

function callArgumentShapeMatches(
  parameters: C3Parameter[],
  args: C3CallArgument[],
): boolean {
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = parameterIndexForCallArgumentWithCursor(
      parameters,
      arg,
      supplied,
      positionalCursor,
      variadicIndex,
    );
    if (parameterIndex === undefined) return false;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;
  }

  return true;
}

function nextPositionalIndex(
  parameters: C3Parameter[],
  supplied: Set<number>,
  cursor: number,
  variadicIndex: number,
): number {
  let index = cursor;

  while (index < parameters.length && supplied.has(index)) {
    index++;
  }

  if (variadicIndex >= 0 && index >= variadicIndex) return variadicIndex;
  return index;
}

function unifyTypeNames(
  genericType: string,
  concreteType: string,
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  const genericRef = parseTypeRef(genericType);
  const concreteRef = parseTypeRef(concreteType);
  if (!genericRef || !concreteRef) return;

  unifyTypeRefs(genericRef, concreteRef, genericParams, substitution);
}

function unifyTypeRefs(
  genericRef: C3TypeRef,
  concreteRef: C3TypeRef,
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  if (genericParams.has(genericRef.normalized)) {
    bindGenericParam(genericRef.normalized, concreteRef.source, substitution);
    return;
  }

  if (!sameNominalType(genericRef, concreteRef)) return;
  if (genericRef.arguments.length !== concreteRef.arguments.length) return;

  for (let index = 0; index < genericRef.arguments.length; index++) {
    const genericArg = genericRef.arguments[index];
    const concreteArg = concreteRef.arguments[index];
    if (!genericArg || !concreteArg) continue;

    unifyTypeRefs(genericArg, concreteArg, genericParams, substitution);
  }
}

function bindGenericParam(
  param: string,
  concreteType: string,
  substitution: Map<string, string>,
): void {
  const existing = substitution.get(param);
  if (!existing) {
    substitution.set(param, concreteType);
    return;
  }

  if (typeNamesCompatible(concreteType, existing)) return;
}

function substituteGenericParams(
  text: string,
  substitution: Map<string, string>,
): string {
  let result = text;

  for (const [param, replacement] of substitution) {
    const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(^|[^A-Za-z0-9_$@])${escaped}(?=$|[^A-Za-z0-9_$@])`, 'g'),
      `$1${replacement}`,
    );
  }

  return result;
}

function sameNominalType(a: C3TypeRef, b: C3TypeRef): boolean {
  return a.nominal === b.nominal || a.terminal === b.terminal;
}

function genericParameterCountForSymbol(symbol: C3Symbol): number {
  return (
    symbol.effectiveGenericParams?.length ??
    symbol.genericParameterCount ??
    symbol.typeInfo?.effectiveGenericParams?.length ??
    symbol.typeInfo?.genericParameterCount ??
    0
  );
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

function initializerListAtPosition(
  root: SyntaxNode,
  position: Position,
): SyntaxNode | undefined {
  const node = root.descendantForPosition({
    row: position.line,
    column: Math.max(0, position.character - 1),
  });

  return ancestorOfType(node, 'initializer_list');
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

function sameSyntaxNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

function offsetAtPosition(
  source: string,
  position: Position,
): number | undefined {
  let line = 0;
  let character = 0;

  for (let offset = 0; offset < source.length; offset++) {
    if (line === position.line && character === position.character) {
      return offset;
    }

    if (source[offset] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return line === position.line && character === position.character
    ? source.length
    : undefined;
}

function positionAtOffset(source: string, targetOffset: number): Position {
  let line = 0;
  let character = 0;
  const boundedOffset = Math.max(0, Math.min(targetOffset, source.length));

  for (let offset = 0; offset < boundedOffset; offset++) {
    if (source[offset] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { line, character };
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

const transparentExpressionTypes = new Set([
  'paren_expr',
  'optional_expr',
  'rethrow_expr',
]);

function symbolCompletionItem(symbol: C3Symbol): CompletionItem {
  return {
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  };
}

function autoImportCompletionItem(
  current: ParsedDocument,
  moduleName: string,
  symbol: C3Symbol,
): CompletionItem {
  return {
    ...symbolCompletionItem(symbol),
    detail: `${symbol.signature} (auto import ${moduleName})`,
    sortText: `~${symbol.name}`,
    additionalTextEdits: [importTextEdit(current, moduleName)],
  };
}

function identifierCompletionItem(
  item: CompletionItem,
  context?: IdentifierCompletionContext,
): CompletionItem {
  if (!context?.prefix.startsWith('$')) return item;

  return {
    ...item,
    textEdit: {
      range: context.replaceRange,
      newText: item.insertText ?? String(item.label),
    },
  };
}

function methodCompletionsForType(
  index: ProjectIndex,
  current: ParsedDocument,
  typeName: string,
  position: Position,
): CompletionItem[] {
  return index
    .memberSymbolsForType(current.uri, typeName, position)
    .filter((symbol) => symbol.kind === SymbolKind.Method)
    .map((symbol) => ({
      label: symbol.name,
      kind: CompletionItemKind.Method,
      detail: symbol.signature,
    }));
}

function moduleMemberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  prefix: string,
): CompletionItem[] {
  const mod = index.resolveModuleFromPrefix(current, prefix);
  const moduleItems = index
    .moduleChildNamesForPrefix(current, prefix)
    .map((name) => ({
      label: name,
      kind: CompletionItemKind.Module,
      detail: `module ${prefix}::${name}`,
    }));

  if (!mod) return moduleItems;

  const symbols = [...mod.symbols.values()].flat();

  return [
    ...moduleItems,
    ...symbols.map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    })),
  ];
}

function modulePathCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ModulePathCompletionContext,
): CompletionItem[] {
  return index
    .modulePathCandidates(current, context.pathPrefix)
    .map((candidate) => ({
      label: candidate.label,
      kind: CompletionItemKind.Module,
      detail: `module ${candidate.moduleName}`,
      textEdit: {
        range: context.replaceRange,
        newText: candidate.label,
      },
    }));
}

function toCompletionKind(kind: SymbolKind): CompletionItemKind {
  switch (kind) {
    case SymbolKind.Function:
      return CompletionItemKind.Function;
    case SymbolKind.Method:
      return CompletionItemKind.Method;
    case SymbolKind.Field:
      return CompletionItemKind.Field;
    case SymbolKind.Struct:
      return CompletionItemKind.Struct;
    case SymbolKind.Enum:
      return CompletionItemKind.Enum;
    case SymbolKind.Interface:
      return CompletionItemKind.Interface;
    case SymbolKind.Constant:
      return CompletionItemKind.Constant;
    case SymbolKind.Variable:
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Text;
  }
}

function uniqueCompletionItems(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const unique: CompletionItem[] = [];

  for (const item of items) {
    if (seen.has(item.label)) continue;

    seen.add(item.label);
    unique.push(item);
  }

  return unique;
}

function completionLabelMatchesPrefix(label: string, prefix: string): boolean {
  return prefix.length === 0 || label.startsWith(prefix);
}
