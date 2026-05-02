import { Range, type Position } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export type ReferenceAtPosition = {
  text: string;
  segment: string;
  segmentIndex: number;
  segmentRange: Range;
  prefix: string;
  terminal: boolean;
};

export function wordAtPosition(
  doc: TextDocument,
  position: Position,
): string | null {
  return referenceAtPosition(doc, position)?.text ?? null;
}

export function referenceAtPosition(
  doc: TextDocument,
  position: Position,
): ReferenceAtPosition | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const span = referenceSpanAtOffset(text, offset);
  if (!span) return null;

  const word = text.slice(span.start, span.end);
  if (!isQualifiedReference(word)) return null;

  const anchor = Math.min(
    Math.max(offset, span.start),
    Math.max(span.start, span.end - 1),
  );
  const segments = referenceSegments(word, span.start);
  const segmentIndex = segments.findIndex(
    (segment) => segment.start <= anchor && anchor <= segment.end,
  );
  const segment = segments[segmentIndex];

  if (!segment || segmentIndex < 0) return null;

  return {
    text: word,
    segment: segment.text,
    segmentIndex,
    segmentRange: Range.create(
      doc.positionAt(segment.start),
      doc.positionAt(segment.end),
    ),
    prefix: segments
      .slice(0, segmentIndex + 1)
      .map((part) => part.text)
      .join('::'),
    terminal: segmentIndex === segments.length - 1,
  };
}

function referenceSpanAtOffset(
  text: string,
  offset: number,
): { start: number; end: number } | undefined {
  const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:$@]/.test(ch);

  let start = offset;
  while (start > 0 && isRefChar(text[start - 1] ?? '')) {
    start--;
  }

  let end = offset;
  while (end < text.length && isRefChar(text[end] ?? '')) {
    end++;
  }

  return start < end ? { start, end } : undefined;
}

function referenceSegments(
  ref: string,
  offset: number,
): Array<{ text: string; start: number; end: number }> {
  const segments: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;

  for (const part of ref.split('::')) {
    const end = start + part.length;
    segments.push({
      text: part,
      start: offset + start,
      end: offset + end,
    });
    start = end + 2;
  }

  return segments;
}

function isQualifiedReference(word: string): boolean {
  return /^[A-Za-z_$@][A-Za-z0-9_$@]*(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)*$/.test(
    word,
  );
}
