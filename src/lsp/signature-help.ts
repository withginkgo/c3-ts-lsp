import {
  ParameterInformation,
  type Position,
  type Range,
  type SignatureHelp,
  type SignatureInformation,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from '../project/project-index.js';
import { isCallableSymbol, callableParameters } from '../shared/callable.js';
import {
  callArguments,
  callTargetFor,
  rangeFromNode,
} from '../shared/calls.js';
import type { C3Parameter, ParsedDocument } from '../shared/types.js';

export function signatureHelp(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): SignatureHelp | null {
  if (!doc || !current) return null;

  const call = callExpressionAtPosition(current.tree.rootNode, position);
  if (!call) return null;

  const functionNode = call.childForFieldName('function');
  if (!functionNode) return null;

  const callTarget = callTargetFor(functionNode);
  if (!callTarget) return null;

  const result = index.resolveSymbol(
    current.uri,
    callTarget.ref,
    callTarget.position,
  );
  const callables = (
    result.selected ? [result.selected] : result.candidates
  ).filter(isCallableSymbol);

  if (callables.length === 0) return null;

  const firstParameters = callableParameters(callables[0]!, {
    methodStyle: callTarget.methodStyle,
  });
  const activeParameter = activeParameterIndex(
    doc,
    call,
    position,
    firstParameters,
  );

  return {
    signatures: callables.map(
      (symbol): SignatureInformation => ({
        label: symbol.signature,
        documentation: symbol.documentation,
        parameters: callableParameters(symbol, {
          methodStyle: callTarget.methodStyle,
        }).map((parameter) => ParameterInformation.create(parameter.label)),
      }),
    ),
    activeSignature: 0,
    activeParameter,
  };
}

function callExpressionAtPosition(
  root: SyntaxNode,
  position: Position,
): SyntaxNode | undefined {
  let current: SyntaxNode | null = root.descendantForPosition({
    row: position.line,
    column: position.character,
  });

  while (current) {
    if (
      current.type === 'call_expr' &&
      positionInRange(position, rangeFromNode(current))
    ) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function activeParameterIndex(
  doc: TextDocument,
  call: SyntaxNode,
  position: Position,
  parameters: C3Parameter[],
): number {
  const activeArg = callArguments(call).find((arg) =>
    positionInRange(position, arg.range),
  );
  if (activeArg?.name) {
    const namedIndex = parameters.findIndex(
      (parameter) => parameter.name === activeArg.name,
    );
    if (namedIndex >= 0) return namedIndex;
  }

  const args = call.childForFieldName('arguments');
  if (!args) return 0;

  const offset = Math.min(doc.offsetAt(position), args.endIndex);
  const start = args.startIndex + 1;
  if (offset <= start) return 0;

  const index = countTopLevelCommas(doc.getText().slice(start, offset));
  return parameters.length > 0 ? Math.min(index, parameters.length - 1) : 0;
}

function countTopLevelCommas(text: string): number {
  let commas = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (const char of text) {
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote !== '`' && char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ',' && depth === 0) commas++;
  }

  return commas;
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
