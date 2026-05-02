import {
  CompletionItemKind,
  InsertTextFormat,
  Location,
  MarkupKind,
  SymbolKind,
  type CompletionItem,
  type Hover,
  type Position,
  type Range,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { SyntaxNode } from 'tree-sitter';

import { literalTypeName, rangeFromNode } from '../analysis/type-analysis.js';
import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  collectionElementTypeName,
  normalizeTypeName,
} from '../shared/type-ref.js';
import type {
  C3ContractKind,
  C3Symbol,
  ParsedDocument,
  ResolveResult,
} from '../shared/types.js';
import {
  identifierCompletionBeforeCursor,
  memberAccessBeforeCursor,
} from './completion-context.js';
import { wordAtPosition } from './document-refs.js';
import { symbolHover } from './hover.js';

type ContractContext = {
  callable: C3Symbol;
  kind?: C3ContractKind;
  contractNode?: SyntaxNode;
  docRange: Range;
};

type ContractScopeSymbol = {
  symbol: C3Symbol;
  source: 'parameter' | 'local' | 'global';
};

export type ContractSemanticToken = {
  range: Range;
  type: string;
};

const CONTRACT_DIRECTIVES = [
  {
    label: '@require',
    detail: 'contract precondition',
    insertText: '@require(${1:condition})',
  },
  {
    label: '@ensure',
    detail: 'contract postcondition',
    insertText: '@ensure(${1:condition})',
  },
  {
    label: '@param',
    detail: 'contract parameter annotation',
    insertText: '@param [${1:in}] ${2:parameter}',
  },
  {
    label: '@pure',
    detail: 'contract purity annotation',
    insertText: '@pure',
  },
];

const operatorPattern = /\+\+\+|<<=|>>=|==|!=|<=|>=|&&|\|\||[+\-*/%<>=!&|^?:]/g;

export function contractCompletionItems(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument,
  position: Position,
): CompletionItem[] | null {
  const context = contractContextAt(doc, current, position);
  if (!context) return null;

  const directiveContext = contractDirectiveCompletionContext(doc, position);
  if (directiveContext) {
    return contractDirectiveCompletions(directiveContext);
  }

  if (context.kind !== 'require' && context.kind !== 'ensure') {
    return [];
  }

  const memberAccess = memberAccessBeforeCursor(doc, position);
  if (memberAccess) {
    return contractMemberCompletions(index, current, context, memberAccess);
  }

  const identifier = identifierCompletionBeforeCursor(doc, position);
  const items: CompletionItem[] = [];

  if (
    context.kind === 'ensure' &&
    'return'.startsWith(identifier.prefix) &&
    context.callable.returnType
  ) {
    items.push({
      label: 'return',
      kind: CompletionItemKind.Keyword,
      detail: context.callable.returnType,
      sortText: '0_return',
    });
  }

  for (const scoped of contractScopeSymbols(index, current, context.callable)) {
    if (!scoped.symbol.name.startsWith(identifier.prefix)) continue;

    items.push({
      label: scoped.symbol.name,
      kind: completionKindForSymbol(scoped.symbol),
      detail: scoped.symbol.returnType ?? scoped.symbol.signature,
      sortText: contractCompletionSortText(scoped),
    });
  }

  return uniqueCompletionItems(items);
}

export function contractHover(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument | undefined,
  position: Position,
): Hover | null {
  if (!current) return null;

  const context = contractContextAt(doc, current, position);
  if (!context) return null;

  const word = wordAtPosition(doc, position);
  if (!word) return null;

  if (word === 'return' && context.kind === 'ensure') {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: [
          '```c3',
          `return: ${context.callable.returnType ?? 'void'}`,
          '```',
        ].join('\n'),
      },
    };
  }

  const result = resolveContractReference(index, current, context, position);
  if (result.selected) return symbolHover(index, result.selected);

  return null;
}

export function contractDefinition(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument | undefined,
  position: Position,
): Location | Location[] | null {
  if (!current) return null;

  const context = contractContextAt(doc, current, position);
  if (!context) return null;

  const result = resolveContractReference(index, current, context, position);
  if (result.reason === 'ambiguous') {
    return result.candidates.map(symbolLocation);
  }

  return result.selected ? symbolLocation(result.selected) : null;
}

export function contractSemanticTokens(
  parsed: ParsedDocument,
  index?: ProjectIndex,
): ContractSemanticToken[] {
  const tokens: ContractSemanticToken[] = [];

  for (const callable of flattenSymbols(parsed.symbols).filter(
    isCallableSymbol,
  )) {
    for (const node of contractNodesForSymbol(parsed, callable)) {
      const name = node.childForFieldName('name');
      const kind = name ? contractKind(name.text) : undefined;
      if (name) {
        tokens.push({ range: rangeFromNode(name), type: 'keyword' });
      }

      const context: ContractContext = {
        callable,
        kind,
        contractNode: node,
        docRange: rangeFromNode(node),
      };

      for (const expression of contractExpressionNodes(node)) {
        collectContractExpressionTokens(
          tokens,
          parsed,
          index,
          context,
          expression,
        );
      }
    }
  }

  return uniqueSemanticTokens(tokens).sort(compareTokens);
}

export function contractContextAt(
  doc: TextDocument,
  current: ParsedDocument,
  position: Position,
): ContractContext | null {
  const docRange = docCommentRangeAt(doc, position);
  if (!docRange) return null;

  const callable =
    flattenSymbols(current.symbols)
      .filter(isCallableSymbol)
      .find((symbol) => rangeContainsPosition(symbol.range, position)) ??
    callableAfterDocComment(current, docRange);
  if (!callable) return null;

  const node = contractNodeAt(current, position);
  const name =
    node?.childForFieldName('name')?.text ?? contractNameOnLine(doc, position);

  return {
    callable,
    kind: name ? contractKind(name) : undefined,
    contractNode: node,
    docRange,
  };
}

function callableAfterDocComment(
  current: ParsedDocument,
  docRange: Range,
): C3Symbol | undefined {
  return flattenSymbols(current.symbols)
    .filter(isCallableSymbol)
    .filter((symbol) => comparePositions(docRange.end, symbol.range.start) <= 0)
    .sort((left, right) =>
      comparePositions(left.range.start, right.range.start),
    )[0];
}

function contractDirectiveCompletionContext(
  doc: TextDocument,
  position: Position,
): { prefix: string; replaceRange: Range } | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  const match = before.match(/(^|\s)(@[A-Za-z_]*)$/);
  if (!match?.[2]) return null;

  const prefix = match[2];
  return {
    prefix,
    replaceRange: {
      start: doc.positionAt(offset - prefix.length),
      end: position,
    },
  };
}

function contractDirectiveCompletions(context: {
  prefix: string;
  replaceRange: Range;
}): CompletionItem[] {
  return CONTRACT_DIRECTIVES.filter((directive) =>
    directive.label.startsWith(context.prefix),
  ).map((directive, index) => ({
    label: directive.label,
    kind: CompletionItemKind.Snippet,
    detail: directive.detail,
    insertTextFormat: InsertTextFormat.Snippet,
    sortText: `0${index}_${directive.label}`,
    textEdit: {
      range: context.replaceRange,
      newText: directive.insertText,
    },
  }));
}

function contractMemberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  memberAccess: { receiver: string; position: Position },
): CompletionItem[] {
  const typeName = contractExpressionTypeNameFromText(
    index,
    current,
    context,
    memberAccess.receiver,
    memberAccess.position,
  );
  if (!typeName) return [];

  return index
    .memberSymbolsForType(
      current.uri,
      typeName,
      context.callable.selectionRange.start,
    )
    .map((symbol) => ({
      label: symbol.name,
      kind: completionKindForSymbol(symbol),
      detail: symbol.signature,
      sortText: `0_${symbol.name}`,
    }));
}

function resolveContractReference(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  position: Position,
): ResolveResult {
  const word = wordAtPosition(
    {
      getText: () => current.source,
      offsetAt: textOffsetAt(current.source),
      positionAt: textPositionAt(current.source),
    } as TextDocument,
    position,
  );
  if (!word || word === 'return') {
    return { candidates: [], reason: 'not_found' };
  }

  const member = contractMemberReferenceAt(index, current, context, position);
  if (member)
    return { candidates: [member], selected: member, reason: 'resolved' };

  const scoped = contractScopeSymbols(index, current, context.callable).filter(
    (item) => item.symbol.name === word,
  );
  const local = scoped.find((item) => item.source !== 'global')?.symbol;
  if (local)
    return { candidates: [local], selected: local, reason: 'resolved' };

  return index.resolveSymbol(
    current.uri,
    word,
    context.callable.selectionRange.start,
  );
}

function contractMemberReferenceAt(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  position: Position,
): C3Symbol | undefined {
  const node = nodeAtPosition(current.tree.rootNode, position);
  const access = ancestorOfType(node, 'access_ident');
  if (!access || !access.parent || access.parent.type !== 'field_expr') {
    return undefined;
  }

  const fieldExpr = access.parent;
  const field = fieldExpr.childForFieldName('field');
  const argument = fieldExpr.childForFieldName('argument');
  if (!field || !argument) return undefined;

  const typeName = contractExpressionTypeName(
    index,
    current,
    context,
    argument,
  );
  if (!typeName) return undefined;

  return index
    .memberSymbolsForType(
      current.uri,
      typeName,
      context.callable.selectionRange.start,
    )
    .find((symbol) => symbol.name === field.text);
}

function collectContractExpressionTokens(
  tokens: ContractSemanticToken[],
  parsed: ParsedDocument,
  index: ProjectIndex | undefined,
  context: ContractContext,
  node: SyntaxNode,
): void {
  if (node.type === 'ident_expr') {
    if (node.text === 'return' && context.kind === 'ensure') {
      tokens.push({ range: rangeFromNode(node), type: 'keyword' });
      return;
    }

    const symbol = index
      ? resolveContractIdentifier(index, parsed, context, node.text)?.symbol
      : undefined;
    if (symbol) {
      tokens.push({
        range: rangeFromNode(node),
        type: semanticTokenTypeForSymbol(symbol),
      });
    }
  }

  if (node.type === 'field_expr') {
    const field = node.childForFieldName('field');
    if (field) tokens.push({ range: rangeFromNode(field), type: 'property' });
  }

  collectOperatorTokens(tokens, parsed.source, node);

  for (const child of node.namedChildren) {
    collectContractExpressionTokens(tokens, parsed, index, context, child);
  }
}

function collectOperatorTokens(
  tokens: ContractSemanticToken[],
  source: string,
  node: SyntaxNode,
): void {
  if (!isExpressionNode(node)) return;

  const lineStarts = lineStartsFor(source);
  const text = node.text;
  let match: RegExpExecArray | null;

  operatorPattern.lastIndex = 0;
  while ((match = operatorPattern.exec(text))) {
    const start = node.startIndex + match.index;
    const end = start + match[0].length;
    tokens.push({
      range: rangeFromOffsets(lineStarts, start, end),
      type: 'operator',
    });
  }
}

function resolveContractIdentifier(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  name: string,
): ContractScopeSymbol | undefined {
  return contractScopeSymbols(index, current, context.callable).find(
    (item) => item.symbol.name === name,
  );
}

function contractScopeSymbols(
  index: ProjectIndex,
  current: ParsedDocument,
  callable: C3Symbol,
): ContractScopeSymbol[] {
  const symbols: ContractScopeSymbol[] = [];
  const seen = new Set<string>();

  const add = (
    source: ContractScopeSymbol['source'],
    candidates: C3Symbol[],
  ): void => {
    for (const symbol of candidates) {
      if (!symbol.name || seen.has(symbol.name)) continue;

      seen.add(symbol.name);
      symbols.push({ symbol, source });
    }
  };

  add(
    'parameter',
    callable.children.filter(
      (symbol) =>
        symbol.kind === SymbolKind.Variable ||
        symbol.kind === SymbolKind.Function,
    ),
  );
  add(
    'local',
    current.scopedSymbols.filter(
      (symbol) =>
        rangeContainsPosition(callable.range, symbol.selectionRange.start) &&
        !sameRange(symbol.selectionRange, callable.selectionRange),
    ),
  );
  add('global', index.visibleSymbols(current));

  return symbols;
}

function contractExpressionTypeNameFromText(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  expressionText: string,
  position: Position,
): string | undefined {
  const parts = splitMemberExpression(expressionText);
  if (parts.length === 0) return undefined;

  let typeName = contractBaseExpressionTypeName(
    index,
    current,
    context,
    parts[0],
    position,
  );

  for (const part of parts.slice(1)) {
    if (!typeName) return undefined;

    const memberName = memberNameFromSegment(part);
    if (!memberName) return undefined;

    const member = index
      .memberSymbolsForType(
        current.uri,
        typeName,
        context.callable.selectionRange.start,
      )
      .find((candidate) => candidate.name === memberName.name);
    typeName = member?.returnType;

    if (typeName && memberName.indexed) {
      typeName = collectionElementTypeName(typeName);
    }
  }

  return typeName;
}

function contractExpressionTypeName(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  expression: SyntaxNode,
): string | undefined {
  const literal = literalTypeName(expression);
  if (literal) return literal;

  if (expression.type === 'ident_expr') {
    if (expression.text === 'return' && context.kind === 'ensure') {
      return context.callable.returnType;
    }

    return (
      resolveContractIdentifier(index, current, context, expression.text)
        ?.symbol.returnType ??
      index.typeNameForExpression(
        current.uri,
        expression.text,
        context.callable.selectionRange.start,
      )
    );
  }

  if (expression.type === 'field_expr') {
    const argument = expression.childForFieldName('argument');
    const field = expression.childForFieldName('field');
    if (!argument || !field) return undefined;

    const typeName = contractExpressionTypeName(
      index,
      current,
      context,
      argument,
    );
    if (!typeName) return undefined;

    return index
      .memberSymbolsForType(
        current.uri,
        typeName,
        context.callable.selectionRange.start,
      )
      .find((symbol) => symbol.name === field.text)?.returnType;
  }

  if (expression.type === 'call_expr') {
    const functionNode = expression.childForFieldName('function');
    if (!functionNode) return undefined;

    const member =
      functionNode.type === 'field_expr'
        ? contractMemberSymbolForFieldExpression(
            index,
            current,
            context,
            functionNode,
          )
        : undefined;
    if (member?.returnType) return member.returnType;

    return index.resolveSymbol(
      current.uri,
      functionNode.text,
      context.callable.selectionRange.start,
    ).selected?.returnType;
  }

  if (expression.type === 'binary_expr') {
    if (/(?:&&|\|\||==|!=|<=|>=|<|>)/.test(expression.text)) return 'bool';

    const left =
      expression.childForFieldName('left') ?? expression.namedChildren[0];
    const right =
      expression.childForFieldName('right') ?? expression.namedChildren.at(-1);
    return (
      (left && contractExpressionTypeName(index, current, context, left)) ??
      (right && contractExpressionTypeName(index, current, context, right)) ??
      undefined
    );
  }

  if (expression.type === 'paren_expr' || expression.type === 'paren_cond') {
    const inner = expression.namedChildren[0];
    return inner
      ? contractExpressionTypeName(index, current, context, inner)
      : undefined;
  }

  if (expression.type === 'unary_expr') {
    const argument = expression.childForFieldName('argument');
    const typeName = argument
      ? contractExpressionTypeName(index, current, context, argument)
      : undefined;
    if (!typeName) return undefined;

    const text = expression.text.trim();
    if (text.startsWith('&')) return `${normalizeTypeName(typeName)}*`;
    if (text.startsWith('*')) return normalizeTypeName(typeName);
    return typeName;
  }

  if (expression.type === 'subscript_expr') {
    const argument = expression.childForFieldName('argument');
    const typeName = argument
      ? contractExpressionTypeName(index, current, context, argument)
      : undefined;
    return typeName ? collectionElementTypeName(typeName) : undefined;
  }

  return index.typeNameForExpression(
    current.uri,
    expression.text,
    context.callable.selectionRange.start,
  );
}

function contractMemberSymbolForFieldExpression(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  fieldExpression: SyntaxNode,
): C3Symbol | undefined {
  const argument = fieldExpression.childForFieldName('argument');
  const field = fieldExpression.childForFieldName('field');
  if (!argument || !field) return undefined;

  const typeName = contractExpressionTypeName(
    index,
    current,
    context,
    argument,
  );
  if (!typeName) return undefined;

  return index
    .memberSymbolsForType(
      current.uri,
      typeName,
      context.callable.selectionRange.start,
    )
    .find((symbol) => symbol.name === field.text);
}

function contractBaseExpressionTypeName(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ContractContext,
  expressionText: string,
  position: Position,
): string | undefined {
  const text = stripOuterParens(expressionText.trim());
  if (!text) return undefined;

  if (text === 'return' && context.kind === 'ensure') {
    return context.callable.returnType;
  }

  if (text.startsWith('&')) {
    const innerType = contractBaseExpressionTypeName(
      index,
      current,
      context,
      text.slice(1),
      position,
    );
    return innerType ? `${normalizeTypeName(innerType)}*` : undefined;
  }

  if (text.startsWith('*')) {
    const innerType = contractBaseExpressionTypeName(
      index,
      current,
      context,
      text.slice(1),
      position,
    );
    return innerType ? normalizeTypeName(innerType) : undefined;
  }

  const subscript = text.match(/^(?<base>.+)\[[^\]]*\]$/);
  if (subscript?.groups?.base) {
    const baseType = contractBaseExpressionTypeName(
      index,
      current,
      context,
      subscript.groups.base,
      position,
    );
    return baseType ? collectionElementTypeName(baseType) : undefined;
  }

  const call = text.match(/^(?<callee>.+)\([^()]*\)$/);
  if (call?.groups?.callee) {
    return contractExpressionTypeNameFromText(
      index,
      current,
      context,
      call.groups.callee,
      position,
    );
  }

  if (
    /^[A-Za-z_$@][A-Za-z0-9_$@]*(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)*$/.test(text)
  ) {
    return (
      resolveContractIdentifier(index, current, context, text)?.symbol
        .returnType ??
      index.typeNameForExpression(
        current.uri,
        text,
        context.callable.selectionRange.start,
      )
    );
  }

  return index.typeNameForExpression(current.uri, text, position);
}

function splitMemberExpression(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}')
      depth = Math.max(0, depth - 1);

    if (char !== '.' || depth !== 0) continue;

    parts.push(text.slice(start, index).trim());
    start = index + 1;
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function memberNameFromSegment(
  text: string,
): { name: string; indexed: boolean } | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^([A-Za-z_$@][A-Za-z0-9_$@]*)(?:\([^()]*\))?(?:\[[^\]]*\])?$/,
  );
  if (!match?.[1]) return undefined;

  return {
    name: match[1],
    indexed: /\[[^\]]*\]\s*$/.test(trimmed),
  };
}

function stripOuterParens(text: string): string {
  let current = text;

  while (current.startsWith('(') && current.endsWith(')')) {
    const inner = current.slice(1, -1);
    if (!balancedDelimiters(inner)) break;
    current = inner.trim();
  }

  return current;
}

function balancedDelimiters(text: string): boolean {
  let depth = 0;

  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }

  return depth === 0;
}

function contractNodeAt(
  current: ParsedDocument,
  position: Position,
): SyntaxNode | undefined {
  const node = nodeAtPosition(current.tree.rootNode, position);
  return ancestorOfType(node, 'doc_comment_contract');
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

function contractNameOnLine(
  doc: TextDocument,
  position: Position,
): string | undefined {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const line = text.slice(lineStart, lineEnd >= 0 ? lineEnd : text.length);
  const match = line.match(/@(require|ensure|param|return|pure)\b/);
  return match ? `@${match[1]}` : undefined;
}

function docCommentRangeAt(
  doc: TextDocument,
  position: Position,
): Range | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const start = text.lastIndexOf('<*', offset);
  if (start < 0) return null;

  const end = text.indexOf('*>', start + 2);
  if (end < 0 || offset > end + 2) return null;

  return {
    start: doc.positionAt(start),
    end: doc.positionAt(end + 2),
  };
}

function contractKind(name: string): C3ContractKind {
  switch (name) {
    case '@require':
      return 'require';
    case '@ensure':
      return 'ensure';
    case '@param':
      return 'param';
    case '@return':
      return 'return';
    case '@pure':
      return 'pure';
    default:
      return 'other';
  }
}

function completionKindForSymbol(symbol: C3Symbol): CompletionItemKind {
  switch (symbol.kind) {
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

function semanticTokenTypeForSymbol(symbol: C3Symbol): string {
  if (symbol.signature.startsWith('macro ')) return 'macro';

  switch (symbol.kind) {
    case SymbolKind.Function:
      return 'function';
    case SymbolKind.Method:
      return 'method';
    case SymbolKind.Struct:
    case SymbolKind.TypeParameter:
      return 'type';
    case SymbolKind.Enum:
      return 'enum';
    case SymbolKind.Interface:
      return 'interface';
    case SymbolKind.Field:
    case SymbolKind.Property:
      return 'property';
    case SymbolKind.Constant:
      return 'enumMember';
    default:
      return 'variable';
  }
}

function contractCompletionSortText(scoped: ContractScopeSymbol): string {
  const prefix =
    scoped.source === 'parameter' ? '1' : scoped.source === 'local' ? '2' : '3';

  return `${prefix}_${scoped.symbol.name}`;
}

function uniqueCompletionItems(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const unique: CompletionItem[] = [];

  for (const item of items) {
    const label = String(item.label);
    if (seen.has(label)) continue;

    seen.add(label);
    unique.push(item);
  }

  return unique.sort((left, right) =>
    (left.sortText ?? String(left.label)).localeCompare(
      right.sortText ?? String(right.label),
    ),
  );
}

function uniqueSemanticTokens(
  tokens: ContractSemanticToken[],
): ContractSemanticToken[] {
  const seen = new Set<string>();
  const unique: ContractSemanticToken[] = [];

  for (const token of tokens) {
    const key = [
      token.range.start.line,
      token.range.start.character,
      token.range.end.line,
      token.range.end.character,
      token.type,
    ].join(':');
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(token);
  }

  return unique;
}

function isExpressionNode(node: SyntaxNode): boolean {
  return (
    node.type.endsWith('_expr') ||
    node.type === 'integer_literal' ||
    node.type === 'real_literal' ||
    node.type === 'char_literal' ||
    node.type === 'string_literal' ||
    node.type === 'true' ||
    node.type === 'false' ||
    node.type === 'boolean_literal'
  );
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

function nodeAtPosition(root: SyntaxNode, position: Position): SyntaxNode {
  return root.descendantForPosition({
    row: position.line,
    column: Math.max(0, position.character - 1),
  });
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
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function rangeContainsPosition(range: Range, position: Position): boolean {
  return (
    comparePositions(range.start, position) <= 0 &&
    comparePositions(position, range.end) <= 0
  );
}

function compareTokens(
  left: ContractSemanticToken,
  right: ContractSemanticToken,
): number {
  return (
    comparePositions(left.range.start, right.range.start) ||
    comparePositions(left.range.end, right.range.end)
  );
}

function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function symbolLocation(symbol: C3Symbol): Location {
  return Location.create(symbol.uri, symbol.selectionRange);
}

function lineStartsFor(source: string): number[] {
  const starts = [0];

  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }

  return starts;
}

function rangeFromOffsets(
  lineStarts: number[],
  start: number,
  end: number,
): Range {
  return {
    start: positionFromOffset(lineStarts, start),
    end: positionFromOffset(lineStarts, end),
  };
}

function positionFromOffset(lineStarts: number[], offset: number): Position {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid]!;
    const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = mid - 1;
    } else if (offset >= next) {
      low = mid + 1;
    } else {
      return { line: mid, character: offset - lineStart };
    }
  }

  const lastLine = lineStarts.length - 1;
  return { line: lastLine, character: offset - lineStarts[lastLine]! };
}

function textOffsetAt(source: string): (position: Position) => number {
  const lineStarts = lineStartsFor(source);

  return (position) => {
    const lineStart = lineStarts[position.line] ?? source.length;
    return Math.min(source.length, lineStart + position.character);
  };
}

function textPositionAt(source: string): (offset: number) => Position {
  const lineStarts = lineStartsFor(source);

  return (offset) => positionFromOffset(lineStarts, offset);
}
