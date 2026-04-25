import type { Position } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function wordAtPosition(
  doc: TextDocument,
  position: Position,
): string | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);

  const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:$@]/.test(ch);

  let start = offset;
  while (start > 0 && isRefChar(text[start - 1])) {
    start--;
  }

  let end = offset;
  while (end < text.length && isRefChar(text[end])) {
    end++;
  }

  const word = text.slice(start, end);

  if (
    !/^[A-Za-z_$@][A-Za-z0-9_$@]*(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)*$/.test(word)
  ) {
    return null;
  }

  return word;
}
