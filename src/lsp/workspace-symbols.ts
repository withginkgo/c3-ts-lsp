import type {
  SymbolInformation,
  WorkspaceSymbolParams,
} from 'vscode-languageserver/node.js';

import type { ProjectIndex } from '../project/project-index.js';

export function workspaceSymbols(
  index: ProjectIndex,
  params: WorkspaceSymbolParams,
): SymbolInformation[] {
  return index.workspaceSymbols(params.query).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    location: {
      uri: symbol.uri,
      range: symbol.selectionRange,
    },
    containerName: symbol.moduleName,
  }));
}
