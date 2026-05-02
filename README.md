# C3 TypeScript Language Server

This project is a Node-based language server prototype for C3. It uses
`tree-sitter-c3` to parse C3 source files and `vscode-languageserver` to expose
document symbols, hover, definition, and completion support over LSP.
It also exposes diagnostics, references, rename, signature help, workspace
symbols, code actions, semantic tokens, and inlay hints.

## Features

- C3 project-aware indexing for `project.json` sources, tests, targets, and
  `.c3l` dependency manifests.
- Configurable standard library indexing for imported stdlib modules.
- Workspace file watching for created, changed, and deleted C3 source files.
- Document symbols for top-level C3 declarations.
- Nested document symbols for declaration members, enum values, and parameters.
- Hover and definition lookup across files in the same project, including
  imported modules, relative module paths, module aliases, and struct members.
- Rich hover output for aggregate declarations, member ownership, and resolved
  variable types.
- Module-aware completions for direct, imported, relative, and aliased module
  paths.
- Import and module-alias path completions for indexed workspace, dependency,
  and standard-library modules.
- Auto-import completions for unimported public symbols, using LSP
  `additionalTextEdits` to insert the needed import.
- Scope-aware completions for parameters, locals, chained expression receivers,
  incomplete member access, struct members, implemented interface methods, and
  type method declarations.
- Attribute-aware completions after `@`, including built-in attributes and
  visible `attrdef` declarations.
- Named argument completions inside function, macro, and method-style calls.
- Basic expression type analysis for member access, call return values,
  subscript expressions, pointer-like type suffixes, `??` orelse expressions,
  and method-style calls.
- Syntax and basic semantic diagnostics from tree-sitter parse errors, missing
  imports, unresolved symbols, ambiguous symbols, and invalid call argument
  shapes.
- Declaration-side diagnostics for duplicate functions and type methods.
- Optional compiler-backed diagnostics through a configured `c3c` executable.
- References for declarations, type usages, scoped locals, and resolved member
  accesses.
- Workspace symbols for project declarations and nested members.
- Signature help for function, macro, and method-style calls, including default,
  named, and variadic parameters.
- Rename with workspace edits across declarations and references.
- Code actions for missing imports and unresolved import cleanup.
- Semantic tokens for declaration highlighting.
- Inlay type hints for simple inferred `var` declarations.
- Optional document formatting through a configured external formatter command.

## Project Structure

```text
src/server.ts                 LSP entrypoint and request wiring
src/server/                   LSP capabilities, initialization, and environment helpers
src/lsp/completions.ts        Completion item generation
src/lsp/completion-context.ts Completion cursor/context detection
src/lsp/document-symbols.ts   DocumentSymbol conversion
src/lsp/document-refs.ts      Identifier/reference extraction from documents
src/lsp/hover.ts              Hover formatting
src/lsp/signature-help.ts     Function and macro signature help
src/lsp/rename.ts             Rename workspace edits
src/lsp/code-actions.ts       Quick fixes
src/lsp/semantic-tokens.ts    Semantic token generation
src/lsp/inlay-hints.ts        Inlay hint generation
src/parser/c3-parser.ts       Tree-sitter parsing and symbol extraction
src/project/project-config.ts C3 project.json/manifest.json discovery
src/project/project-index.ts  Module index and symbol resolution
src/toolchain/formatter.ts    Optional external formatter integration
src/toolchain/c3c.ts          Optional c3c diagnostic integration
src/workspace/scan.ts         Workspace file discovery and indexing
src/workspace/watch.ts        Workspace file watching and index updates
src/analysis/diagnostics.ts   Semantic diagnostic generation
src/shared/types.ts           Shared server data types
src/shared/callable.ts        Callable and parameter metadata helpers
src/shared/calls.ts           Call-expression syntax helpers
src/tools/                    Local debug scripts
tests/                        Node test runner coverage for parser/index/LSP helpers
docs/architecture.md          Module boundaries and dependency direction
docs/roadmap.md               Implementation plan toward a usable C3 LSP
docs/versioning.md            Versioning and release workflow
```

## Scripts

```bash
npm test
npm run check
npm run format
npm run format:check
npm run build
npm start
npm run dev
npm run debug:tree
npm run debug:symbols
```

`npm test` type-checks the test suite and then runs the TypeScript tests through
Node's built-in test runner and `tsx`.

`npm run check` runs the full local verification gate: tests plus TypeScript
build.

`npm start` runs the compiled server with `--stdio`. Directly running
`node dist/server.js` is also supported and defaults to stdio when no transport
argument is supplied.

## Configuration

If the workspace root contains `project.json`, the server parses it as JSONC
using the same comment/trailing-comma style emitted by `c3c init`. It indexes
global `sources`, `test-sources`, selected target `sources`, and
`sources-override`. It also scans configured `dependencies` from
`dependency-search-paths` by reading each `.c3l/manifest.json`.

By default the first target in `project.json` is selected, matching `c3c build`.
You can select another project target with initialization options:

```json
{
  "initializationOptions": {
    "projectTarget": "my_target"
  }
}
```

Standard library scanning is opt-in. Provide one or more stdlib source roots
through LSP initialization options:

```json
{
  "initializationOptions": {
    "stdlibPath": "/path/to/c3/lib"
  }
}
```

The server also accepts `stdlibPaths`, `standardLibraryPath`,
`standardLibraryPaths`, `c3StdlibPath`, `c3StdlibPaths`, `stdlib-path`,
`c3.stdlib-path`, `c3.stdlibPath`, and `c3.standardLibraryPath`. Environment
variables `C3_STDLIB_PATH`, `C3_STDLIB_ROOT`, and `C3_STANDARD_LIBRARY_PATH`
are also supported. Multiple paths can be separated with the platform path
delimiter.

### VSCode extension integration

This language server reads stdlib configuration from the LSP `initialize`
request, not from extra command-line arguments passed when the server process is
spawned. If you use the C3 VSCode extension, make sure the extension forwards
its `stdlib-path` setting through the language client's `initializationOptions`.

So, in the extension's `src/lsp.js`, you should insert following snippet:

```js
const serverOptions = {
  run: {
    command: executablePath,
    args: args,
  },
  debug: {
    command: executablePath,
    args: args,
    options: { execArgv: ['--nolazy', '--inspect=6009'] },
  },
};

// initial arguments prepared for lsp server
const initializationOptions = {};
const stdlibPath = config.get('stdlib-path');

if (stdlibPath) {
  initializationOptions.stdlibPath = stdlibPath;
}

const clientOptions = {
  documentSelector: [{ scheme: 'file', language: 'c3' }],
  synchronize: {
    fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{c3,c3i}'),
  },
  // and insert this line
  initializationOptions,
};
```

Completion trigger characters are advertised by the language server during LSP
initialization. A VSCode extension using `vscode-languageclient` should let that
server capability drive completion registration. If the extension registers a
manual completion provider, include the same trigger characters: `.`, `:`, `@`,
and `$`.

Then, rebuild the extension and install from local .vsix file.Enable extension after configure **c3c path**, **c3lsp path**, **c3 std lib path**.

This lsp may start from a bash file like:

```bash
#!/usr/bin/env bash
exec node your_path_lsp/dist/server.js "$@"

```

Make bash file executable and set **c3 lsp path** your_path_to_bash_file.

If `C3_HOME` or `C3C_HOME` is set, the server tries common library subfolders
under that root.

When stdlib files use `module ... @if(env::...)`, the index filters branches
that are definitely inactive for the current host environment. Unknown
conditions stay indexed, but obvious platform alternatives such as Win32 files
on Linux do not participate in symbol resolution.

Compiler-backed diagnostics are opt-in. Enable them with initialization
options:

```json
{
  "initializationOptions": {
    "compilerDiagnostics": true
  }
}
```

When diagnostics are enabled, the server uses a configured `c3cCommand` or
falls back to `c3c` on `PATH`. `c3cCommand` can be a string or an array such as
`["/path/to/c3c", "--target", "x64-linux"]`. The server runs `c3c` with
`--lsp`, `--ansi=no`, and `-C`. If the workspace has `project.json`, it checks
the project with `build <projectTarget>` when a target is selected; otherwise it
checks indexed workspace files with `compile-only`. For custom setups, provide
`compilerCheckArgs`, where `${workspaceRoot}`, `${stdlibRoot}`,
`${projectTarget}`, and `${files}` are expanded before execution.

Compiler diagnostics are debounced and ignored if a newer run starts. Because
`c3c` reads files from disk, diagnostics from `c3c` are cleared for unsaved
buffers and republished after a disk change/save is observed.

## Versioning and Releases

The package version is tracked in `package.json` and `package-lock.json`.
Release notes are tracked in `CHANGELOG.md`.

Current release: `0.2.0`.

Release checklist:

```bash
npm version <version> --no-git-tag-version
npm run build
```

Then add the matching entry to `CHANGELOG.md` before committing or tagging.

## Notes

The server is an LSP process, not a normal CLI. When it starts successfully it
waits for JSON-RPC messages from an editor or LSP client, so no terminal output
is expected during idle startup.
