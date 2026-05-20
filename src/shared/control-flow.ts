import type { SyntaxNode } from 'tree-sitter';

export function nodeAlwaysReturns(node: SyntaxNode): boolean {
  if (node.type === 'return_stmt') return true;
  if (node.type === 'implies_body') return true;

  if (isBlockNode(node)) {
    return blockAlwaysMatches(node, nodeAlwaysReturns);
  }

  if (node.type === 'if_stmt') {
    return ifAlwaysMatches(node, nodeAlwaysReturns);
  }

  if (node.type === 'else_part') {
    const body = node.childForFieldName('body') ?? node.namedChildren[0];
    return body ? nodeAlwaysReturns(body) : false;
  }

  if (node.type === 'while_stmt') {
    return loopCannotFallThrough(node);
  }

  return false;
}

export function nodeCannotCompleteNormally(node: SyntaxNode): boolean {
  if (
    node.type === 'return_stmt' ||
    node.type === 'implies_body' ||
    node.type === 'break_stmt' ||
    node.type === 'continue_stmt'
  ) {
    return true;
  }

  if (isBlockNode(node)) {
    return blockAlwaysMatches(node, nodeCannotCompleteNormally);
  }

  if (node.type === 'if_stmt') {
    return ifAlwaysMatches(node, nodeCannotCompleteNormally);
  }

  if (node.type === 'else_part') {
    const body = node.childForFieldName('body') ?? node.namedChildren[0];
    return body ? nodeCannotCompleteNormally(body) : false;
  }

  if (node.type === 'while_stmt') {
    return loopCannotFallThrough(node);
  }

  return false;
}

export function referenceNarrowedAfterCatch(reference: SyntaxNode): boolean {
  if (reference.type !== 'ident_expr') return false;

  const name = reference.text;
  let current: SyntaxNode | null = reference;

  while (current?.parent) {
    const parent: SyntaxNode = current.parent;

    if (isBlockNode(parent)) {
      const child = directChildContaining(parent, current);
      const childIndex = child
        ? parent.namedChildren.findIndex((candidate: SyntaxNode) =>
            sameNode(candidate, child),
          )
        : -1;

      for (let index = childIndex - 1; index >= 0; index--) {
        const sibling = parent.namedChildren[index]!;

        if (writesToVariable(sibling, name)) return false;
        if (isTerminatingCatchGuardFor(sibling, name)) return true;
      }
    }

    current = parent;
  }

  return false;
}

function blockAlwaysMatches(
  node: SyntaxNode,
  predicate: (node: SyntaxNode) => boolean,
): boolean {
  for (const child of node.namedChildren) {
    if (predicate(child)) return true;
  }

  return false;
}

function ifAlwaysMatches(
  node: SyntaxNode,
  predicate: (node: SyntaxNode) => boolean,
): boolean {
  const body = node.childForFieldName('body');
  const elsePart = directChildOfType(node, 'else_part');

  return !!body && !!elsePart && predicate(body) && predicate(elsePart);
}

function loopCannotFallThrough(node: SyntaxNode): boolean {
  const body = node.childForFieldName('body');

  if (body && nodeAlwaysReturns(body)) return true;
  if (!isTrueCondition(node.childForFieldName('condition'))) return false;

  return body ? !containsEscapingBreak(body) : true;
}

function isTrueCondition(condition: SyntaxNode | null): boolean {
  if (!condition) return false;

  if (condition.text.replace(/[()\s]/g, '') === 'true') return true;

  const expression =
    condition.type === 'paren_cond'
      ? condition.namedChildren[0]
      : (condition.namedChildren[0] ?? condition);

  return expression?.type === 'true' || expression?.text.trim() === 'true';
}

function containsEscapingBreak(node: SyntaxNode): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'break_stmt') return true;

    if (isNestedBreakBoundary(child)) continue;
    if (containsEscapingBreak(child)) return true;
  }

  return false;
}

function isNestedBreakBoundary(node: SyntaxNode): boolean {
  return (
    node.type === 'while_stmt' ||
    node.type === 'for_stmt' ||
    node.type === 'foreach_stmt' ||
    node.type === 'switch_stmt'
  );
}

function isBlockNode(node: SyntaxNode): boolean {
  return (
    node.type === 'macro_func_body' ||
    node.type === 'compound_stmt' ||
    node.type === 'ct_stmt_body'
  );
}

function isTerminatingCatchGuardFor(node: SyntaxNode, name: string): boolean {
  if (node.type !== 'if_stmt') return false;

  const condition = node.childForFieldName('condition');
  const body = node.childForFieldName('body');
  if (!condition || !body) return false;
  if (!nodeCannotCompleteNormally(body)) return false;

  return descendantsOfType(condition, 'catch_unwrap').some((unwrap) =>
    descendantsOfType(unwrap, 'ident_expr').some(
      (reference) => reference.text === name,
    ),
  );
}

function writesToVariable(node: SyntaxNode, name: string): boolean {
  if (node.type === 'declaration') {
    return node.childForFieldName('name')?.text === name;
  }

  if (node.type === 'assignment_expr') {
    const left = node.childForFieldName('left') ?? node.namedChildren[0];
    return left?.text === name;
  }

  return node.namedChildren.some((child) => writesToVariable(child, name));
}

function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  function visit(current: SyntaxNode): void {
    if (current.type === type) {
      found.push(current);
      return;
    }

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node);
  return found;
}

function directChildContaining(
  node: SyntaxNode,
  target: SyntaxNode,
): SyntaxNode | undefined {
  return node.namedChildren.find(
    (child) =>
      target.startIndex >= child.startIndex &&
      target.endIndex <= child.endIndex,
  );
}

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function sameNode(left: SyntaxNode, right: SyntaxNode): boolean {
  return (
    left.startIndex === right.startIndex && left.endIndex === right.endIndex
  );
}
