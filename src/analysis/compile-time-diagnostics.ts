import {
  DiagnosticSeverity,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { normalizeTypeName } from '../shared/type-ref.js';
import type { ParsedDocument } from '../shared/types.js';
import {
  constantExpression,
  constantTypeName,
  type ConstantValue,
} from './const-eval.js';
import { rangeFromNode } from './type-analysis.js';

const diagnosticSource = 'c3-lsp';

export function compileTimeDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...ctAssertDiagnostics(index, parsed),
    ...ctConditionDiagnostics(index, parsed),
  ].sort((a, b) => compareRanges(a.range, b.range));
}

function ctAssertDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const statement of nodesOfType(parsed.tree.rootNode, 'ct_assert_stmt')) {
    const condition = firstExpressionChild(statement);
    if (!condition) continue;

    const value = constantExpression(index, parsed, condition);
    pushBoolDiagnostic(diagnostics, condition, value, '$assert condition');

    if (value.kind === 'bool' && !value.value) {
      diagnostics.push(
        error(
          rangeFromNode(condition),
          assertMessage(statement) ?? 'Compile-time assertion is always false',
        ),
      );
    }
  }

  return diagnostics;
}

function ctConditionDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const condition of nodesOfType(parsed.tree.rootNode, 'ct_if_cond')) {
    const expression = firstExpressionChild(condition);
    if (!expression) continue;

    pushBoolDiagnostic(
      diagnostics,
      expression,
      constantExpression(index, parsed, expression),
      'compile-time condition',
    );
  }

  return diagnostics;
}

function pushBoolDiagnostic(
  diagnostics: Diagnostic[],
  expression: SyntaxNode,
  value: ConstantValue,
  label: string,
): void {
  const typeName = constantTypeName(value);

  if (!typeName || normalizeTypeName(typeName) === 'bool') return;

  diagnostics.push(
    error(
      rangeFromNode(expression),
      `${label} should be 'bool', got '${typeName}'`,
    ),
  );
}

function assertMessage(statement: SyntaxNode): string | undefined {
  const message = statement.namedChildren.find(
    (child) =>
      child.type === 'string_literal' ||
      child.type === 'raw_string_literal' ||
      child.type === 'string_expr',
  );
  if (!message) return undefined;

  return `Compile-time assertion is always false: ${message.text}`;
}

function firstExpressionChild(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find(
    (child) =>
      child.type !== 'string_literal' &&
      child.type !== 'raw_string_literal' &&
      child.type !== 'string_expr',
  );
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

function error(range: Range, message: string): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
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
