import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseSource } from '../parser/c3-parser.js';
import type { ProjectIndex } from '../project/project-index.js';

type WorkspaceScanReporter = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

const c3Extensions = new Set(['.c3', '.c3i', '.c3t']);
const skippedDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.zig-cache',
]);

export function scanWorkspace(
  root: string,
  index: ProjectIndex,
  reporter: WorkspaceScanReporter = {},
): number {
  const files = collectC3Files(root);

  reporter.log?.(`found ${files.length} C3 files`);

  for (const file of files) {
    try {
      const source = fs.readFileSync(file, 'utf8');
      const uri = pathToFileURL(file).toString();

      index.upsert(parseSource(uri, source), false);
    } catch (err) {
      reporter.error?.(`failed to parse ${file}: ${String(err)}`);
    }
  }

  index.rebuild();
  reporter.log?.(`indexed ${index.moduleCount()} modules`);

  return files.length;
}

export function collectC3Files(root: string): string[] {
  const result: string[] = [];

  function walkDir(dir: string): void {
    const base = path.basename(dir);

    if (skippedDirectories.has(base)) {
      return;
    }

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(full);
        continue;
      }

      if (entry.isFile() && isC3SourceFile(full)) {
        result.push(full);
      }
    }
  }

  walkDir(root);
  return result;
}

function isC3SourceFile(file: string): boolean {
  return c3Extensions.has(path.extname(file));
}
