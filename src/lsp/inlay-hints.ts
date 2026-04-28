import {
  InlayHint,
  InlayHintKind,
  Position,
  type Range,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';

export function inlayHints(
  index: ProjectIndex,
  current: ParsedDocument | undefined,
  range: Range,
): InlayHint[] {
  if (!current) return [];

  const hints: InlayHint[] = [];

  for (const declaration of descendantsOfType(
    current.tree.rootNode,
    'var_declaration',
  )) {
    if (!varDeclarationAllowed(declaration)) continue;

    const name = declaration.childForFieldName('name');
    const right = declaration.childForFieldName('right');
    if (!name || !right || !positionInRange(rangeFromNode(name).start, range)) {
      continue;
    }

    const typeName =
      index.typeNameForExpression(
        current.uri,
        right.text,
        rangeFromNode(right).start,
      ) ?? literalTypeName(right);

    if (!typeName) continue;

    hints.push(
      InlayHint.create(
        Position.create(name.endPosition.row, name.endPosition.column),
        `: ${typeName}`,
        InlayHintKind.Type,
      ),
    );
  }

  return hints;
}

function varDeclarationAllowed(declaration: SyntaxNode): boolean {
  return (
    !!ancestorOfType(declaration, 'macro_declaration') ||
    hasAttribute(declaration, '@safeinfer') ||
    varDeclarationInitializesLambda(declaration)
  );
}

function varDeclarationInitializesLambda(declaration: SyntaxNode): boolean {
  const right = declaration.childForFieldName('right');

  return !!right && right.type.startsWith('lambda_');
}

function hasAttribute(node: SyntaxNode, name: string): boolean {
  for (const attributes of directChildrenOfType(node, 'attributes')) {
    for (const attribute of directChildrenOfType(attributes, 'attribute')) {
      if (attribute.text.split('(')[0] === name) return true;
    }
  }

  return false;
}

function ancestorOfType(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | undefined {
  let current = node?.parent;

  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }

  return undefined;
}

function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  for (const child of node.namedChildren) {
    if (child.type === type) found.push(child);
    found.push(...descendantsOfType(child, type));
  }

  return found;
}

function directChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === type);
}

function positionInRange(position: Position, range: Range): boolean {
  return (
    comparePositions(range.start, position) <= 0 &&
    comparePositions(position, range.end) <= 0
  );
}

function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function rangeFromNode(node: SyntaxNode): Range {
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

function literalTypeName(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case 'integer_literal':
      return 'int';
    case 'real_literal':
      return 'float';
    case 'char_literal':
      return 'char';
    case 'string_literal':
      return 'String';
    case 'true':
    case 'false':
    case 'boolean_literal':
      return 'bool';
    default:
      return undefined;
  }
}
