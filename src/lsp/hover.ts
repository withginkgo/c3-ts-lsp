import {
  MarkupKind,
  SymbolKind,
  type Hover,
} from 'vscode-languageserver/node.js';

import type { ProjectIndex } from '../project/project-index.js';
import type { C3Symbol, ResolveResult } from '../shared/types.js';

const aggregateKinds = new Set<SymbolKind>([
  SymbolKind.Struct,
  SymbolKind.Enum,
  SymbolKind.Interface,
]);

export function hoverFromResolveResult(
  index: ProjectIndex,
  result: ResolveResult,
): Hover | null {
  if (result.selected) {
    return symbolHover(index, result.selected);
  }

  if (result.reason === 'ambiguous') {
    return ambiguousHover(result.candidates);
  }

  return null;
}

export function symbolHover(index: ProjectIndex, symbol: C3Symbol): Hover {
  const sections = [codeBlock(formatPrimarySymbol(symbol))];
  const owner = index.ownerSymbol(symbol);
  const typeSymbol = index.typeSymbolFor(symbol);

  if (symbol.documentation) {
    sections.push(symbol.documentation);
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

  sections.push(`module: \`${symbol.moduleName || '<unknown>'}\``);

  if (index.sourceKindForSymbol(symbol) === 'stdlib') {
    sections.push('source: `stdlib`');
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

function formatPrimarySymbol(symbol: C3Symbol): string {
  return aggregateKinds.has(symbol.kind)
    ? formatAggregateSymbol(symbol)
    : symbol.signature;
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
