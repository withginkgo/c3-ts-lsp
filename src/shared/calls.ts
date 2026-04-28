import { Range, type Position } from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

export type C3CallTarget = {
  ref: string;
  position: Position;
  methodStyle: boolean;
  range: Range;
};

export type C3CallArgument = {
  node: SyntaxNode;
  range: Range;
  name?: string;
  nameRange?: Range;
};

export function callTargetFor(functionNode: SyntaxNode): C3CallTarget | null {
  if (functionNode.type === 'field_expr') {
    const field = functionNode.childForFieldName('field');
    if (!field) return null;

    return {
      ref: field.text,
      position: rangeFromNode(field).start,
      methodStyle: true,
      range: rangeFromNode(field),
    };
  }

  return {
    ref: functionNode.text,
    position: rangeFromNode(functionNode).start,
    methodStyle: false,
    range: rangeFromNode(functionNode),
  };
}

export function callArguments(call: SyntaxNode): C3CallArgument[] {
  const args = call.childForFieldName('arguments');
  if (!args) return [];

  return args.namedChildren
    .filter((child) => child.type === 'call_arg')
    .map((arg) => {
      const name = arg.childForFieldName('name');

      return {
        node: arg,
        range: rangeFromNode(arg),
        name: name?.text,
        nameRange: name ? rangeFromNode(name) : undefined,
      };
    });
}

export function callExpressionNodes(root: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'call_expr') {
      calls.push(node);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return calls;
}

export function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}
