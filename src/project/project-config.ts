import fs from 'node:fs';
import path from 'node:path';

import { collectC3Files, isC3SourceFile } from '../workspace/scan.js';

export type C3ProjectModel = {
  root: string;
  projectFile: string;
  targetName?: string;
  targetNames: string[];
  sourcePatterns: string[];
  testSourcePatterns: string[];
  dependencySearchPaths: string[];
  dependencies: string[];
  sourceFiles: string[];
  dependencyFiles: string[];
  dependencyRoots: string[];
};

export type C3ProjectModelOptions = {
  targetName?: string;
  includeTests?: boolean;
};

type JsonObject = Record<string, unknown>;

const sourceKeys = {
  append: 'sources',
  override: 'sources-override',
};

const testSourceKeys = {
  append: 'test-sources',
  override: 'test-sources-override',
};

const dependencySearchPathKeys = {
  append: 'dependency-search-paths',
  override: 'dependency-search-paths-override',
};

const dependencyKeys = {
  append: 'dependencies',
  override: 'dependencies-override',
};

export function resolveC3ProjectModel(
  workspaceRoot: string,
  options: C3ProjectModelOptions = {},
): C3ProjectModel | null {
  const projectFile = path.join(workspaceRoot, 'project.json');
  if (!isFile(projectFile)) return null;

  const project = readJsoncObject(projectFile);
  const targets = objectValue(project.targets);
  const targetNames = targets ? Object.keys(targets) : [];
  const targetName = selectTargetName(targetNames, options.targetName);
  const target =
    targetName && targets ? objectValue(targets[targetName]) : null;
  const includeTests = options.includeTests ?? true;

  const sourcePatterns = mergeStringList(project, target, sourceKeys);
  const testSourcePatterns = includeTests
    ? mergeStringList(project, target, testSourceKeys)
    : [];
  const dependencySearchPaths = mergeStringList(
    project,
    target,
    dependencySearchPathKeys,
  ).map((item) => resolveProjectPath(workspaceRoot, item));
  const dependencies = mergeStringList(project, target, dependencyKeys);
  const sourceFiles = collectFilesForPatterns(workspaceRoot, [
    ...sourcePatterns,
    ...testSourcePatterns,
  ]);
  const dependencyRoots = resolveDependencyRoots(
    workspaceRoot,
    dependencySearchPaths,
    dependencies,
  );
  const dependencyFiles = collectDependencyFiles(dependencyRoots);

  return {
    root: workspaceRoot,
    projectFile,
    targetName,
    targetNames,
    sourcePatterns,
    testSourcePatterns,
    dependencySearchPaths,
    dependencies,
    sourceFiles,
    dependencyFiles,
    dependencyRoots,
  };
}

export function projectTargetFromInitializationOptions(
  options: unknown,
): string | undefined {
  if (!options || typeof options !== 'object') return undefined;

  const record = options as Record<string, unknown>;
  const value =
    record.projectTarget ??
    record.c3ProjectTarget ??
    record.c3cProjectTarget ??
    record.compilerProjectTarget ??
    record['c3.projectTarget'] ??
    record['c3.project-target'] ??
    record['c3.targetName'];

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function matchesProjectSource(
  model: C3ProjectModel,
  filePath: string,
): boolean {
  if (!isC3SourceFile(filePath)) return false;

  return matchesAnyProjectPattern(model.root, filePath, [
    ...model.sourcePatterns,
    ...model.testSourcePatterns,
  ]);
}

export function isProjectConfigFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === 'project.json' || base === 'manifest.json';
}

export function parseJsoncObject(source: string): JsonObject {
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source)));

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }

  return parsed as JsonObject;
}

function readJsoncObject(filePath: string): JsonObject {
  try {
    return parseJsoncObject(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to parse ${filePath}: ${String(err)}`);
  }
}

function selectTargetName(
  targetNames: string[],
  configured: string | undefined,
): string | undefined {
  if (configured && targetNames.includes(configured)) return configured;
  return targetNames[0];
}

function mergeStringList(
  global: JsonObject,
  target: JsonObject | null,
  keys: { append: string; override: string },
): string[] {
  const override = target ? stringListValue(target[keys.override]) : undefined;
  if (override) return override;

  return [
    ...(stringListValue(global[keys.append]) ?? []),
    ...(target ? (stringListValue(target[keys.append]) ?? []) : []),
  ];
}

function stringListValue(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];

  if (!Array.isArray(value)) return undefined;

  const result = value.filter(
    (item): item is string => typeof item === 'string',
  );
  return result.length > 0 || value.length === 0 ? result : undefined;
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function collectFilesForPatterns(root: string, patterns: string[]): string[] {
  if (patterns.length === 0) return collectC3Files(root).sort(comparePaths);

  const files = new Set<string>();

  for (const pattern of patterns) {
    for (const file of collectFilesForPattern(root, pattern)) {
      files.add(file);
    }
  }

  return [...files].sort(comparePaths);
}

function collectFilesForPattern(root: string, rawPattern: string): string[] {
  const normalized = normalizeProjectPattern(rawPattern);
  if (!normalized) return [];

  const literalPath = resolveProjectPath(root, normalized);

  if (!hasGlob(normalized)) {
    if (isFile(literalPath) && isC3SourceFile(literalPath))
      return [literalPath];
    if (isDirectory(literalPath)) return collectC3Files(literalPath);
    return [];
  }

  const baseDir = globBaseDir(root, normalized);
  if (!isDirectory(baseDir)) return [];

  const regex = globPatternRegex(normalized);
  return collectC3Files(baseDir).filter((file) => {
    return regex.test(relativeProjectPath(root, file));
  });
}

function matchesAnyProjectPattern(
  root: string,
  filePath: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return isPathInside(filePath, root);

  return patterns.some((pattern) => {
    const normalized = normalizeProjectPattern(pattern);
    if (!normalized) return false;

    const literalPath = resolveProjectPath(root, normalized);

    if (!hasGlob(normalized)) {
      return literalPath === filePath || isPathInside(filePath, literalPath);
    }

    return globPatternRegex(normalized).test(
      relativeProjectPath(root, filePath),
    );
  });
}

function resolveDependencyRoots(
  projectRoot: string,
  dependencySearchPaths: string[],
  dependencies: string[],
): string[] {
  const roots = new Set<string>();

  for (const dependency of dependencies) {
    if (!dependency) continue;

    for (const searchPath of dependencySearchPaths) {
      for (const root of candidateDependencyRoots(searchPath, dependency)) {
        if (isDirectory(root)) roots.add(root);
      }
    }
  }

  if (roots.size === 0) {
    const libRoot = path.join(projectRoot, 'lib');
    if (dependencies.length > 0 && isDirectory(libRoot)) {
      for (const dependency of dependencies) {
        for (const root of candidateDependencyRoots(libRoot, dependency)) {
          if (isDirectory(root)) roots.add(root);
        }
      }
    }
  }

  return [...roots].sort(comparePaths);
}

function candidateDependencyRoots(
  searchPath: string,
  dependency: string,
): string[] {
  return [
    path.join(searchPath, dependency),
    path.join(searchPath, `${dependency}.c3l`),
  ];
}

function collectDependencyFiles(dependencyRoots: string[]): string[] {
  const files = new Set<string>();

  for (const root of dependencyRoots) {
    const manifestFile = path.join(root, 'manifest.json');
    const patterns = isFile(manifestFile)
      ? manifestSourcePatterns(manifestFile)
      : [];
    const dependencyFiles =
      patterns.length > 0
        ? collectFilesForPatterns(root, patterns)
        : collectC3Files(root);

    for (const file of dependencyFiles) files.add(file);
  }

  return [...files].sort(comparePaths);
}

function manifestSourcePatterns(manifestFile: string): string[] {
  try {
    const manifest = readJsoncObject(manifestFile);
    return stringListValue(manifest.sources) ?? [];
  } catch {
    return [];
  }
}

function normalizeProjectPattern(pattern: string): string {
  return toPosixPath(pattern.trim()).replace(/^\.\//, '');
}

function resolveProjectPath(root: string, projectPath: string): string {
  return path.resolve(root, projectPath);
}

function globBaseDir(root: string, pattern: string): string {
  const parts = toPosixPath(pattern).split('/');
  const staticParts: string[] = [];

  for (const part of parts) {
    if (hasGlob(part)) break;
    staticParts.push(part);
  }

  return path.resolve(root, ...staticParts);
}

function globPatternRegex(pattern: string): RegExp {
  const normalized = normalizeProjectPattern(pattern);
  let source = '^';

  for (let i = 0; i < normalized.length; ) {
    if (normalized.startsWith('**/', i)) {
      source += '(?:[^/]+/)*';
      i += 3;
      continue;
    }

    if (normalized.startsWith('/**', i) && i + 3 === normalized.length) {
      source += '(?:/.*)?';
      i += 3;
      continue;
    }

    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '*' && next === '*') {
      source += '.*';
      i += 2;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      i++;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      i++;
      continue;
    }

    source += escapeRegex(char);
    i++;
  }

  return new RegExp(`${source}$`);
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

function relativeProjectPath(root: string, filePath: string): string {
  return toPosixPath(path.relative(root, filePath));
}

function toPosixPath(filePath: string): string {
  return filePath.split(/[\\/]/).join('/');
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function comparePaths(a: string, b: string): number {
  return a.localeCompare(b);
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function stripJsonComments(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        result += source[i] === '\r' ? '\r' : ' ';
        i++;
      }
      if (i < source.length) result += source[i];
      continue;
    }

    if (char === '/' && next === '*') {
      result += '  ';
      i += 2;

      while (i < source.length) {
        const current = source[i];
        const following = source[i + 1];

        if (current === '*' && following === '/') {
          result += '  ';
          i++;
          break;
        }

        result += current === '\n' || current === '\r' ? current : ' ';
        i++;
      }

      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingCommas(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let cursor = i + 1;
      while (/\s/.test(source[cursor] ?? '')) cursor++;

      if (source[cursor] === '}' || source[cursor] === ']') {
        continue;
      }
    }

    result += char;
  }

  return result;
}
