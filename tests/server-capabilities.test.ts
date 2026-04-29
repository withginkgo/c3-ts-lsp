import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serverInitializeResult } from '../src/server/capabilities.js';

test('serverInitializeResult declares stable LSP capabilities', () => {
  const result = serverInitializeResult({ formatting: true });
  const capabilities = result.capabilities;

  assert.equal(capabilities.documentFormattingProvider, true);
  assert.deepEqual(capabilities.signatureHelpProvider, {
    triggerCharacters: ['(', ','],
  });
  assert.deepEqual(capabilities.completionProvider, {
    triggerCharacters: [':', '.', '@', '$', ','],
  });
  assert.equal(capabilities.semanticTokensProvider?.full, true);
});

test('serverInitializeResult disables formatting when no formatter is configured', () => {
  const result = serverInitializeResult({ formatting: false });

  assert.equal(result.capabilities.documentFormattingProvider, false);
});
