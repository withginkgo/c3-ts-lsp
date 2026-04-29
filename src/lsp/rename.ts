import {
  TextEdit,
  type Position,
  type Range,
  type WorkspaceEdit,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';
import { wordAtPosition } from './document-refs.js';

const identifierPattern = /^[A-Za-z_$@][A-Za-z0-9_$@]*$/;

export function renameSymbol(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
  newName: string,
): WorkspaceEdit | null {
  if (!doc || !current || !identifierPattern.test(newName)) return null;

  const ref = wordAtPosition(doc, position);
  if (!ref) return null;

  const result = index.resolveSymbol(current.uri, ref, position);
  const symbol = result.selected;
  if (!symbol || index.sourceKindForSymbol(symbol) !== 'workspace') return null;

  const changes: Record<string, TextEdit[]> = {};

  for (const location of index.referencesTo(symbol)) {
    const edits = changes[location.uri] ?? [];
    edits.push(TextEdit.replace(location.range, newName));
    changes[location.uri] = edits;
  }

  return Object.keys(changes).length > 0 ? { changes } : null;
}

export function prepareRename(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): { range: Range; placeholder: string } | null {
  if (!doc || !current) return null;

  const ref = wordAtPosition(doc, position);
  if (!ref) return null;

  const result = index.resolveSymbol(current.uri, ref, position);
  const symbol = result.selected;
  if (!symbol || index.sourceKindForSymbol(symbol) !== 'workspace') return null;

  return {
    range:
      referenceNameRange(doc, position, symbol.name) ?? symbol.selectionRange,
    placeholder: symbol.name,
  };
}

function referenceNameRange(
  doc: TextDocument,
  position: Position,
  name: string,
): Range | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const isRefChar = (char: string): boolean => /[A-Za-z0-9_:$@]/.test(char);

  let start = offset;
  while (start > 0 && isRefChar(text[start - 1])) start--;

  let end = offset;
  while (end < text.length && isRefChar(text[end])) end++;

  const word = text.slice(start, end);
  const nameOffset = word.lastIndexOf(name);
  if (nameOffset < 0) return null;

  return {
    start: doc.positionAt(start + nameOffset),
    end: doc.positionAt(start + nameOffset + name.length),
  };
}
