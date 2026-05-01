import {
  TextDocumentSyncKind,
  type InitializeResult,
} from 'vscode-languageserver/node.js';

import { semanticTokenLegend } from '../lsp/semantic-tokens.js';

export type ServerCapabilityOptions = {
  formatting: boolean;
};

export function serverInitializeResult(
  options: ServerCapabilityOptions,
): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
      },
      renameProvider: {
        prepareProvider: true,
      },
      codeActionProvider: true,
      semanticTokensProvider: {
        legend: semanticTokenLegend,
        full: true,
      },
      inlayHintProvider: true,
      documentFormattingProvider: options.formatting,
      completionProvider: {
        triggerCharacters: [':', '.', '@', '$'],
      },
    },
  };
}
