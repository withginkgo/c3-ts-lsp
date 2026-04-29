import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  matchesProjectSource,
  parseJsoncObject,
  projectTargetFromInitializationOptions,
  resolveC3ProjectModel,
} from '../src/project/project-config.js';

test('parseJsoncObject accepts C3 project comments and trailing commas', () => {
  assert.deepEqual(
    parseJsoncObject(`
      {
        // line comment
        "sources": [ "src/**", ],
        "url": "https://example.test/not-a-comment",
        /*
         * block comment
         */
        "targets": {
          "app": {
            "type": "executable",
          },
        },
      }
    `),
    {
      sources: ['src/**'],
      url: 'https://example.test/not-a-comment',
      targets: {
        app: {
          type: 'executable',
        },
      },
    },
  );
});

test('resolveC3ProjectModel expands target sources, tests, and c3l dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-project-model-'));

  try {
    writeFile(root, 'src/main.c3');
    writeFile(root, 'src/nested/deep.c3');
    writeFile(root, 'test/main_test.c3');
    writeFile(root, 'extra/plugin.c3');
    writeFile(root, 'tool/tool.c3');
    writeFile(root, 'lib/math.c3l/api/math.c3i');
    writeJsonc(
      root,
      'lib/math.c3l/manifest.json',
      `{
        "provides": "math",
        "sources": [ "api/**", ],
      }`,
    );
    writeJsonc(
      root,
      'project.json',
      `{
        "sources": [ "src/**/*.c3" ],
        "test-sources": [ "test/**" ],
        "dependency-search-paths": [ "lib" ],
        "dependencies": [ "math" ],
        "targets": {
          "app": {
            "type": "executable",
            "sources": [ "extra/*.c3" ],
          },
          "tool": {
            "type": "executable",
            "sources-override": [ "tool/**" ],
            "dependencies-override": [],
          },
        },
      }`,
    );

    const model = resolveC3ProjectModel(root, { targetName: 'app' });

    assert.equal(model?.targetName, 'app');
    assert.deepEqual(model?.targetNames, ['app', 'tool']);
    assert.deepEqual(relativePaths(root, model?.sourceFiles ?? []), [
      'extra/plugin.c3',
      'src/main.c3',
      'src/nested/deep.c3',
      'test/main_test.c3',
    ]);
    assert.deepEqual(relativePaths(root, model?.dependencyFiles ?? []), [
      'lib/math.c3l/api/math.c3i',
    ]);
    assert.equal(
      matchesProjectSource(model!, path.join(root, 'src/new.c3')),
      true,
    );
    assert.equal(
      matchesProjectSource(model!, path.join(root, 'docs/readme.c3')),
      false,
    );

    const toolModel = resolveC3ProjectModel(root, { targetName: 'tool' });

    assert.deepEqual(relativePaths(root, toolModel?.sourceFiles ?? []), [
      'test/main_test.c3',
      'tool/tool.c3',
    ]);
    assert.deepEqual(toolModel?.dependencies, []);
    assert.deepEqual(toolModel?.dependencyFiles, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectTargetFromInitializationOptions accepts common client option names', () => {
  assert.equal(
    projectTargetFromInitializationOptions({ 'c3.project-target': 'demo' }),
    'demo',
  );
  assert.equal(projectTargetFromInitializationOptions({}), undefined);
});

function writeFile(root: string, relativePath: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'module test;\n');
}

function writeJsonc(root: string, relativePath: string, source: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function relativePaths(root: string, files: string[]): string[] {
  return files.map((file) =>
    path.relative(root, file).split(path.sep).join('/'),
  );
}
