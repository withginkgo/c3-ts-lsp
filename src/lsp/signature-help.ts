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
  type C3CallTarget,
  rangeFromNode,
} from '../shared/calls.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';
import {
  callArgumentContextBeforeCursor,
  methodContext,
  type CallArgumentContext,
} from './completion-context.js';

export function signatureHelp(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): SignatureHelp | null {
  if (!doc || !current) return null;

  const call = callExpressionAtPosition(current.tree.rootNode, position);
  if (!call) {
    return signatureHelpFromTextContext(index, doc, current, position);
  }

  const functionNode = call.childForFieldName('function');
  if (!functionNode) return null;

  const callTarget = callTargetFor(functionNode);
  if (!callTarget) return null;

  const callables = callablesForTarget(index, current, callTarget);

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
    signatures: callables.map((symbol) =>
      signatureInformation(symbol, callTarget.methodStyle),
    ),
    activeSignature: 0,
    activeParameter,
  };
}

function signatureHelpFromTextContext(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument,
  position: Position,
): SignatureHelp | null {
  const context = callArgumentContextBeforeCursor(doc, position);
  if (!context) return null;

  const { callables, methodStyle } = callablesForTextContext(
    index,
    current,
    context,
  );
  if (callables.length === 0) return null;

  const firstParameters = callableParameters(callables[0]!, { methodStyle });

  return {
    signatures: callables.map((symbol) =>
      signatureInformation(symbol, methodStyle),
    ),
    activeSignature: 0,
    activeParameter: activeParameterIndexFromText(
      context.argumentsText,
      firstParameters,
    ),
  };
}

function callablesForTarget(
  index: ProjectIndex,
  current: ParsedDocument,
  callTarget: C3CallTarget,
): C3Symbol[] {
  const result = index.resolveCallableSymbol(
    current.uri,
    callTarget.ref,
    callTarget.position,
  );

  return (result.selected ? [result.selected] : result.candidates).filter(
    isCallableSymbol,
  );
}

function callablesForTextContext(
  index: ProjectIndex,
  current: ParsedDocument,
  context: CallArgumentContext,
): { callables: C3Symbol[]; methodStyle: boolean } {
  const method = methodContext(context.callee);

  if (method) {
    return {
      methodStyle: true,
      callables: index
        .memberSymbolsForExpression(
          current.uri,
          method.receiver,
          context.calleePosition,
        )
        .filter(
          (candidate) =>
            candidate.name === method.name && isCallableSymbol(candidate),
        ),
    };
  }

  return {
    methodStyle: false,
    callables: callablesForTarget(index, current, {
      ref: context.callee,
      position: context.calleePosition,
      methodStyle: false,
      range: {
        start: context.calleePosition,
        end: context.calleePosition,
      },
      genericArgs: [],
    }),
  };
}

function signatureInformation(
  symbol: C3Symbol,
  methodStyle: boolean,
): SignatureInformation {
  return {
    label: symbol.signature,
    documentation: symbol.documentation,
    parameters: callableParameters(symbol, { methodStyle }).map((parameter) =>
      ParameterInformation.create(parameter.label),
    ),
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

function activeParameterIndexFromText(
  argumentsText: string,
  parameters: C3Parameter[],
): number {
  const named = activeArgumentText(argumentsText).match(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/,
  );
  if (named?.[1]) {
    const namedIndex = parameters.findIndex(
      (parameter) => parameter.name === named[1],
    );
    if (namedIndex >= 0) return namedIndex;
  }

  const index = countTopLevelCommas(argumentsText);
  return parameters.length > 0 ? Math.min(index, parameters.length - 1) : 0;
}

function activeArgumentText(argumentsText: string): string {
  const comma = lastTopLevelCommaIndex(argumentsText);
  return argumentsText.slice(comma + 1);
}

function lastTopLevelCommaIndex(text: string): number {
  return topLevelCommaIndexes(text).at(-1) ?? -1;
}

function countTopLevelCommas(text: string): number {
  return topLevelCommaIndexes(text).length;
}

function topLevelCommaIndexes(text: string): number[] {
  const commas: number[] = [];
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

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

    if (char === ',' && depth === 0) commas.push(index);
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
