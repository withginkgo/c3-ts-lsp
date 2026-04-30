import {
  CodeAction,
  CodeActionKind,
  Range,
  TextEdit,
  type CodeActionParams,
  type Diagnostic,
} from 'vscode-languageserver/node.js';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';
import { importTextEdit } from './import-edits.js';

export function codeActions(
  index: ProjectIndex,
  current: ParsedDocument | undefined,
  params: CodeActionParams,
): CodeAction[] {
  if (!current) return [];

  return params.context.diagnostics.flatMap((diagnostic) => [
    ...missingImportActions(index, current, diagnostic),
    ...unresolvedImportActions(current, diagnostic),
  ]);
}

function missingImportActions(
  index: ProjectIndex,
  current: ParsedDocument,
  diagnostic: Diagnostic,
): CodeAction[] {
  const match = diagnostic.message.match(
    /^(?:Unresolved symbol|Undefined variable) '([^']+)'$/,
  );
  if (!match) return [];

  const ref = match[1].split('::').at(-1);
  if (!ref) return [];

  return index
    .importCandidatesForSymbol(current, ref)
    .slice(0, 5)
    .map(({ moduleName }) => {
      const action = CodeAction.create(
        `Import ${moduleName}`,
        {
          changes: {
            [current.uri]: [importTextEdit(current, moduleName)],
          },
        },
        CodeActionKind.QuickFix,
      );

      action.diagnostics = [diagnostic];
      return action;
    });
}

function unresolvedImportActions(
  current: ParsedDocument,
  diagnostic: Diagnostic,
): CodeAction[] {
  if (!diagnostic.message.startsWith('Unresolved import ')) return [];

  const line = diagnostic.range.start.line;
  const action = CodeAction.create(
    'Remove unresolved import',
    {
      changes: {
        [current.uri]: [TextEdit.del(fullLineRange(current.source, line))],
      },
    },
    CodeActionKind.QuickFix,
  );

  action.diagnostics = [diagnostic];
  return [action];
}

function fullLineRange(source: string, line: number): Range {
  const lines = source.split('\n');
  const character = lines[line]?.length ?? 0;
  const endLine = line < lines.length - 1 ? line + 1 : line;
  const endCharacter = line < lines.length - 1 ? 0 : character;

  return Range.create(line, 0, endLine, endCharacter);
}
