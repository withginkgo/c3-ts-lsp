# C3 TypeScript Language Server

This project is a Node-based language server prototype for C3. It uses
`tree-sitter-c3` to parse C3 source files and `vscode-languageserver` to expose
document symbols, hover, definition, and completion support over LSP.

## Features

- Workspace-wide C3 indexing for `.c3`, `.c3i`, and `.c3t` files.
- Workspace file watching for created, changed, and deleted C3 source files.
- Document symbols for top-level C3 declarations.
- Nested document symbols for declaration members, enum values, and parameters.
- Hover and definition lookup across files in the same project, including
  imported modules, relative module paths, and module aliases.
- Module-aware completions for direct, imported, relative, and aliased module
  paths.
- Syntax and basic semantic diagnostics from tree-sitter parse errors, missing
  imports, unresolved symbols, and ambiguous symbols.

## Project Structure

```text
src/server.ts                 LSP entrypoint and request wiring
src/lsp/completions.ts        Completion item generation
src/lsp/document-symbols.ts   DocumentSymbol conversion
src/lsp/document-refs.ts      Identifier/reference extraction from documents
src/parser/c3-parser.ts       Tree-sitter parsing and symbol extraction
src/project/project-index.ts  Module index and symbol resolution
src/workspace/scan.ts         Workspace file discovery and indexing
src/workspace/watch.ts        Workspace file watching and index updates
src/analysis/diagnostics.ts   Semantic diagnostic generation
src/shared/types.ts           Shared server data types
src/tools/                    Local debug scripts
tests/                        Node test runner coverage for parser/index/LSP helpers
docs/roadmap.md               Implementation plan toward a usable C3 LSP
docs/versioning.md            Versioning and release workflow
```

## Scripts

```bash
npm test
npm run check
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
