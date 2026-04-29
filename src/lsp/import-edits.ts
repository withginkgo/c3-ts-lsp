import { Position, TextEdit } from 'vscode-languageserver/node.js';

import type { ParsedDocument } from '../shared/types.js';

export function importTextEdit(
  current: ParsedDocument,
  moduleName: string,
): TextEdit {
  return TextEdit.insert(
    importInsertPosition(current),
    `import ${moduleName};\n`,
  );
}

function importInsertPosition(current: ParsedDocument): Position {
  const lines = current.source.split('\n');
  const moduleLine = lines.findIndex((line) =>
    line.trim().startsWith('module '),
  );

  return Position.create(moduleLine >= 0 ? moduleLine + 1 : 0, 0);
}
