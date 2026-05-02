import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  semanticTokenLegend,
  semanticTokens,
} from '../src/lsp/semantic-tokens.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('semanticTokens encodes declaration tokens for symbols and locals', () => {
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use(HttpResponse response) {',
    '    int count;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource('file:///workspace/app.c3', source);
  const lines = source.split('\n');
  const decoded = decodeTokens(lines, semanticTokens(parsed).data);

  assert.deepEqual(
    decoded.map((token) => [token.text, token.type]),
    [
      ['HttpResponse', 'type'],
      ['body', 'property'],
      ['use', 'function'],
      ['response', 'variable'],
      ['count', 'variable'],
    ],
  );
});

test('semanticTokens encodes contract clauses and expressions', () => {
  const index = new ProjectIndex();
  const source = [
    'module app;',
    '<*',
    ' @require value > 0',
    ' @ensure return == value',
    '*>',
    'fn int checked(int value) {',
    '    return value;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource('file:///workspace/app.c3', source);
  const lines = source.split('\n');

  index.upsert(parsed);

  const decoded = decodeTokens(lines, semanticTokens(parsed, index).data);

  assert.equal(
    decoded.some(
      (token) => token.text === '@require' && token.type === 'keyword',
    ),
    true,
  );
  assert.equal(
    decoded.some(
      (token) => token.text === 'value' && token.type === 'variable',
    ),
    true,
  );
  assert.equal(
    decoded.some((token) => token.text === '>' && token.type === 'operator'),
    true,
  );
  assert.equal(
    decoded.some(
      (token) => token.text === 'return' && token.type === 'keyword',
    ),
    true,
  );
});

function decodeTokens(
  lines: string[],
  data: number[],
): Array<{ text: string; type: string }> {
  const tokens: Array<{ text: string; type: string }> = [];
  let line = 0;
  let character = 0;

  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index]!;
    const deltaCharacter = data[index + 1]!;
    const length = data[index + 2]!;
    const tokenType = data[index + 3]!;

    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;

    tokens.push({
      text: lines[line]!.slice(character, character + length),
      type: semanticTokenLegend.tokenTypes[tokenType]!,
    });
  }

  return tokens;
}
