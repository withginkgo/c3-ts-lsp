import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectC3Files, isC3SourceFile, skippedDirectories } from './scan.js';

type WorkspaceWatchReporter = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WorkspaceWatcher = {
  close(): void;
};

export type WorkspaceWatchHandlers = {
  change(uri: string): void;
  delete(uri: string): void;
};

export function watchWorkspace(
  root: string,
  handlers: WorkspaceWatchHandlers,
  reporter: WorkspaceWatchReporter = {},
): WorkspaceWatcher {
  let watcher: fs.FSWatcher;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;

      const filePath = path.resolve(root, filename.toString());
      if (!shouldHandlePath(filePath)) return;

      scheduleFileEvent(filePath, handlers, pending);
    });
  } catch (err) {
    reporter.error?.(
      `failed to watch workspace ${root}: ${String(err)}; falling back to polling`,
    );
    return pollWorkspace(root, handlers, reporter);
  }

  watcher.on('error', (err) => {
    reporter.error?.(`workspace watcher error: ${String(err)}`);
  });

  reporter.log?.(`watching C3 files in ${root}`);

  return {
    close() {
      for (const timeout of pending.values()) {
        clearTimeout(timeout);
      }

      pending.clear();
      watcher.close();
    },
  };
}

function pollWorkspace(
  root: string,
  handlers: WorkspaceWatchHandlers,
  reporter: WorkspaceWatchReporter,
): WorkspaceWatcher {
  let previous = snapshotC3Files(root);

  const interval = setInterval(() => {
    const current = snapshotC3Files(root);

    for (const [filePath, mtimeMs] of current) {
      if (previous.get(filePath) !== mtimeMs) {
        handlers.change(pathToFileURL(filePath).toString());
      }
    }

    for (const filePath of previous.keys()) {
      if (!current.has(filePath)) {
        handlers.delete(pathToFileURL(filePath).toString());
      }
    }

    previous = current;
  }, 1_500);

  reporter.log?.(`polling C3 files in ${root}`);

  return {
    close() {
      clearInterval(interval);
    },
  };
}

function snapshotC3Files(root: string): Map<string, number> {
  const snapshot = new Map<string, number>();

  for (const filePath of collectC3Files(root)) {
    try {
      snapshot.set(filePath, fs.statSync(filePath).mtimeMs);
    } catch {
      // Ignore files that disappear during the scan.
    }
  }

  return snapshot;
}

function scheduleFileEvent(
  filePath: string,
  handlers: WorkspaceWatchHandlers,
  pending: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const previous = pending.get(filePath);

  if (previous) {
    clearTimeout(previous);
  }

  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      handleFileEvent(filePath, handlers);
    }, 75),
  );
}

function handleFileEvent(
  filePath: string,
  handlers: WorkspaceWatchHandlers,
): void {
  const uri = pathToFileURL(filePath).toString();

  try {
    if (!fs.existsSync(filePath)) {
      handlers.delete(uri);
      return;
    }

    const stat = fs.statSync(filePath);

    if (stat.isFile()) {
      handlers.change(uri);
    }
  } catch {
    handlers.delete(uri);
  }
}

function shouldHandlePath(filePath: string): boolean {
  if (!isC3SourceFile(filePath)) return false;

  const parts = path.normalize(filePath).split(path.sep);
  return !parts.some((part) => skippedDirectories.has(part));
}
