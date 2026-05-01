import {
  DiagnosticSeverity,
  Range,
  type Diagnostic,
  type Position,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { isCallableSymbol } from '../shared/callable.js';
import { nodeAlwaysReturns } from '../shared/control-flow.js';
import { normalizeTypeName } from '../shared/type-ref.js';
import type { C3Symbol, ParsedDocument } from '../shared/types.js';
import {
  expressionTypeName,
  rangeFromNode,
  shouldReportTypeMismatch,
} from './type-analysis.js';

const diagnosticSource = 'c3-lsp';

export function returnDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const symbols = flattenSymbols(parsed.symbols).filter(isCallableSymbol);

  for (const callable of callableDefinitionNodes(parsed.tree.rootNode)) {
    const symbol = symbolForCallable(callable, symbols);
    const body = callable.childForFieldName('body');
    if (!symbol || !body) continue;

    diagnostics.push(
      ...returnStatementDiagnostics(index, parsed, symbol, body),
    );
    diagnostics.push(...missingReturnDiagnostics(symbol, body));
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

function returnStatementDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
  symbol: C3Symbol,
  body: SyntaxNode,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const returnType = symbol.returnType ?? 'void';
  const requiresValue = requiresReturnValue(returnType);

  for (const statement of returnStatementsInBody(body)) {
    const expression = returnExpression(statement);

    if (requiresValue && !expression) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: nonEmptyRangeFromNode(statement),
        message: `Return statement in '${symbol.name}' must return a value of type '${returnType}'`,
        source: diagnosticSource,
      });
      continue;
    }

    if (isPlainVoidType(returnType) && expression) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(expression),
        message: `Void function '${symbol.name}' should not return a value`,
        source: diagnosticSource,
      });
      continue;
    }

    if (!requiresValue || !expression) continue;

    const actualType = expressionTypeName(index, parsed, expression);

    if (
      actualType &&
      shouldReportTypeMismatch(actualType, returnType, expression)
    ) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(expression),
        message: `Cannot return '${actualType}' from '${symbol.name}' with return type '${returnType}'`,
        source: diagnosticSource,
      });
    }
  }

  return diagnostics;
}

function missingReturnDiagnostics(
  symbol: C3Symbol,
  body: SyntaxNode,
): Diagnostic[] {
  const returnType = symbol.returnType ?? 'void';

  if (!requiresReturnValue(returnType)) return [];
  if (hasAttribute(symbol, '@noreturn')) return [];
  if (nodeAlwaysReturns(body)) return [];

  return [
    {
      severity: DiagnosticSeverity.Error,
      range: symbol.selectionRange,
      message: `Function '${symbol.name}' must return a value of type '${returnType}' on all paths`,
      source: diagnosticSource,
    },
  ];
}

function callableDefinitionNodes(root: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'func_definition' || node.type === 'macro_declaration') {
      nodes.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return nodes;
}

function symbolForCallable(
  node: SyntaxNode,
  symbols: C3Symbol[],
): C3Symbol | undefined {
  const name = callableNameNode(node);
  if (!name) return undefined;

  const nameRange = rangeFromNode(name);

  return symbols.find(
    (symbol) =>
      symbol.name === name.text && sameRange(symbol.selectionRange, nameRange),
  );
}

function callableNameNode(node: SyntaxNode): SyntaxNode | undefined {
  const header =
    directChildOfType(node, 'func_header') ??
    directChildOfType(node, 'macro_header');

  return (
    header?.childForFieldName('name') ??
    node.childForFieldName('name') ??
    undefined
  );
}

function returnExpression(statement: SyntaxNode): SyntaxNode | undefined {
  return statement.namedChildren.find((child) => !child.isMissing);
}

function requiresReturnValue(returnType: string): boolean {
  return normalizeTypeName(returnType) !== 'void';
}

function isPlainVoidType(returnType: string): boolean {
  return returnType.replace(/\s+/g, '') === 'void';
}

function hasAttribute(symbol: C3Symbol, name: string): boolean {
  return symbol.attributes.some(
    (attribute) => attribute.split('(')[0] === name,
  );
}

function flattenSymbols(symbols: C3Symbol[]): C3Symbol[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(symbol.children),
  ]);
}

function returnStatementsInBody(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  for (const child of node.namedChildren) {
    if (isNestedCallableBoundary(child)) continue;
    if (child.type === 'return_stmt') found.push(child);
    found.push(...returnStatementsInBody(child));
  }

  return found;
}

function isNestedCallableBoundary(node: SyntaxNode): boolean {
  return (
    node.type === 'func_definition' ||
    node.type === 'macro_declaration' ||
    node.type.startsWith('lambda_')
  );
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function nonEmptyRangeFromNode(node: SyntaxNode): Range {
  const range = rangeFromNode(node);

  if (
    range.start.line === range.end.line &&
    range.start.character === range.end.character
  ) {
    return Range.create(range.start, {
      line: range.end.line,
      character: range.end.character + 1,
    });
  }

  return range;
}

function sameRange(left: Range, right: Range): boolean {
  return (
    comparePositions(left.start, right.start) === 0 &&
    comparePositions(left.end, right.end) === 0
  );
}

function compareRanges(a: Range, b: Range): number {
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}
