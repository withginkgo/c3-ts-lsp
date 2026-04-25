import {
  DiagnosticSeverity,
  Range,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';

const diagnosticSource = 'c3-lsp';

export function semanticDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...unresolvedImportDiagnostics(index, parsed),
    ...unresolvedModuleAliasDiagnostics(index, parsed),
    ...referenceDiagnostics(index, parsed),
  ];
}

function unresolvedImportDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return parsed.importSpecs
    .filter((imp) => !index.resolveImportedModule(parsed, imp.path))
    .map((imp) => ({
      severity: DiagnosticSeverity.Error,
      range: imp.selectionRange,
      message: `Unresolved import '${imp.path}'`,
      source: diagnosticSource,
    }));
}

function unresolvedModuleAliasDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return parsed.moduleAliases
    .filter((alias) => !index.resolveImportedModule(parsed, alias.target))
    .map((alias) => ({
      severity: DiagnosticSeverity.Error,
      range: alias.targetRange,
      message: `Unresolved module alias target '${alias.target}'`,
      source: diagnosticSource,
    }));
}

function referenceDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const ref of referenceNodes(parsed.tree.rootNode)) {
    const result = index.resolveSymbol(
      parsed.uri,
      ref.text,
      rangeFromNode(ref).start,
    );

    if (result.reason === 'not_found') {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(ref),
        message: `Unresolved symbol '${ref.text}'`,
        source: diagnosticSource,
      });
    }

    if (result.reason === 'ambiguous') {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: rangeFromNode(ref),
        message: `Ambiguous symbol '${ref.text}' (${result.candidates.length} candidates)`,
        source: diagnosticSource,
      });
    }
  }

  return diagnostics;
}

function referenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'ident_expr') {
      refs.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}
