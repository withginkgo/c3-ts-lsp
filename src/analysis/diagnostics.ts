import {
  DiagnosticSeverity,
  Range,
  SymbolKind,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  callArguments,
  callExpressionNodes,
  callTargetFor,
  type C3CallArgument,
} from '../shared/calls.js';
import { terminalTypeName } from '../shared/type-ref.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';

const diagnosticSource = 'c3-lsp';

export function semanticDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const importDiagnostics = [
    ...unresolvedImportDiagnostics(index, parsed),
    ...unresolvedModuleAliasDiagnostics(index, parsed),
  ];

  if (parsed.diagnostics.length > 0) {
    return importDiagnostics;
  }

  return [
    ...importDiagnostics,
    ...duplicateCallableDiagnostics(index, parsed),
    ...referenceDiagnostics(index, parsed),
    ...callDiagnostics(index, parsed),
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
    pushReferenceDiagnostic(index, parsed, ref, diagnostics);
  }

  for (const ref of memberReferenceNodes(parsed.tree.rootNode)) {
    pushReferenceDiagnostic(index, parsed, ref, diagnostics);
  }

  return diagnostics;
}

function duplicateCallableDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const mod = index.getModule(parsed.moduleName);
  if (!mod) return [];

  const groups = new Map<string, C3Symbol[]>();

  for (const symbol of [...mod.symbols.values()].flat()) {
    if (!isCallableSymbol(symbol)) continue;

    const key = duplicateCallableKey(symbol);
    const symbols = groups.get(key) ?? [];
    symbols.push(symbol);
    groups.set(key, symbols);
  }

  const diagnostics: Diagnostic[] = [];

  for (const symbols of groups.values()) {
    if (symbols.length < 2) continue;

    for (const symbol of symbols) {
      if (symbol.uri !== parsed.uri) continue;

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: symbol.selectionRange,
        message: duplicateCallableMessage(symbol),
        source: diagnosticSource,
      });
    }
  }

  return diagnostics.sort((a, b) => compareRanges(a.range, b.range));
}

function duplicateCallableKey(symbol: C3Symbol): string {
  return symbol.kind === SymbolKind.Method
    ? `method:${terminalTypeName(symbol.receiverType ?? '')}:${symbol.name}`
    : `function:${symbol.name}`;
}

function duplicateCallableMessage(symbol: C3Symbol): string {
  if (symbol.kind === SymbolKind.Method) {
    const receiver = terminalTypeName(symbol.receiverType ?? '') || '<unknown>';
    return `Duplicate method '${receiver}.${symbol.name}'`;
  }

  return `Duplicate function '${symbol.name}'`;
}

function callDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const call of callExpressionNodes(parsed.tree.rootNode)) {
    const functionNode = call.childForFieldName('function');
    if (!functionNode) continue;

    const target = callTargetFor(functionNode);
    if (!target) continue;

    const result = index.resolveSymbol(parsed.uri, target.ref, target.position);
    const symbol = result.selected;
    if (!symbol || !isCallableSymbol(symbol)) continue;

    diagnostics.push(
      ...validateCallArguments(
        symbol,
        callableParameters(symbol, { methodStyle: target.methodStyle }),
        callArguments(call),
        rangeFromNode(call),
      ),
    );
  }

  return diagnostics;
}

function validateCallArguments(
  symbol: C3Symbol,
  parameters: C3Parameter[],
  args: C3CallArgument[],
  callRange: Range,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;
  let tooManyPositional = false;

  for (const arg of args) {
    if (arg.name) {
      const namedIndex = parameters.findIndex(
        (parameter) => parameter.name === arg.name,
      );

      if (namedIndex < 0) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: arg.nameRange ?? arg.range,
          message: `Unknown named argument '${arg.name}' for '${symbol.name}'`,
          source: diagnosticSource,
        });
        continue;
      }

      if (supplied.has(namedIndex)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: arg.nameRange ?? arg.range,
          message: `Argument '${arg.name}' is already supplied for '${symbol.name}'`,
          source: diagnosticSource,
        });
        continue;
      }

      supplied.add(namedIndex);
      continue;
    }

    const positionalIndex = nextPositionalIndex(
      parameters,
      supplied,
      positionalCursor,
      variadicIndex,
    );

    if (variadicIndex >= 0 && positionalIndex >= variadicIndex) {
      supplied.add(variadicIndex);
      continue;
    }

    if (positionalIndex < parameters.length) {
      supplied.add(positionalIndex);
      positionalCursor = positionalIndex + 1;
    } else {
      tooManyPositional = true;
    }
  }

  const missing = parameters.filter(
    (parameter, index) =>
      !parameter.optional && !parameter.variadic && !supplied.has(index),
  );

  for (const parameter of missing) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: callRange,
      message: `Missing required argument '${parameter.name ?? parameter.label}' for '${symbol.name}'`,
      source: diagnosticSource,
    });
  }

  if (variadicIndex < 0 && tooManyPositional) {
    const expected = argumentRangeLabel(parameters);

    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: callRange,
      message: `'${symbol.name}' expects ${expected} argument${expected === '1' ? '' : 's'}, got ${args.length}`,
      source: diagnosticSource,
    });
  }

  return diagnostics;
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

function argumentRangeLabel(parameters: C3Parameter[]): string {
  const min = parameters.filter(
    (parameter) => !parameter.optional && !parameter.variadic,
  ).length;
  const hasVariadic = parameters.some((parameter) => parameter.variadic);

  if (hasVariadic) return `${min}+`;
  if (min === parameters.length) return String(min);
  return `${min}-${parameters.length}`;
}

function pushReferenceDiagnostic(
  index: ProjectIndex,
  parsed: ParsedDocument,
  ref: SyntaxNode,
  diagnostics: Diagnostic[],
): void {
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

function memberReferenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'field_expr') {
      const field = node.childForFieldName('field');
      if (field) refs.push(field);
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

function compareRanges(a: Range, b: Range): number {
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

function comparePositions(
  a: { line: number; character: number },
  b: { line: number; character: number },
): number {
  return a.line - b.line || a.character - b.character;
}
