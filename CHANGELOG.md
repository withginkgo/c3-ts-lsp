# Changelog

All notable project changes are recorded here.

## [Unreleased]

### Added

- Added a structured resolver result with selected symbol, candidates, and
  resolution status for position-aware symbol lookup.
- Added hover and definition handling for ambiguous symbol candidates.
- Added workspace file watching so changed, created, and deleted C3 source
  files update the project index without restarting the server.
- Added module alias and relative import resolution for hover, definition, and
  module-prefix completions.
- Added semantic diagnostics for unresolved imports, unresolved module alias
  targets, unresolved expression symbols, and ambiguous expression symbols.
- Added member access resolution for struct members, including pointer-like
  receiver types.
- Added local, parameter, and member-aware completions.
- Added an LSP references provider backed by syntax-tree references and symbol
  resolution.

### Changed

- Made position-aware hover and definition avoid unrelated global module
  fallback and report ambiguous imported symbols instead of silently selecting
  the first match.
- Made unqualified completions include visible imported symbols while excluding
  unrelated modules and private imported declarations.
- Made project index updates rebuild only affected modules during single-file
  changes.
- Made hover, definition, diagnostics, and references distinguish struct
  members from unrelated top-level symbols.

## [0.2.0] - 2026-04-25

### Added

- Added a Node test runner setup with TypeScript type-checking for tests.
- Added parser, project-index, and completion tests for the current LSP
  prototype behavior.
- Added parser coverage for bitstruct, alias, typedef, attrdef, union-style
  struct declarations, multiple fault constants, global variables, and external
  function declarations.
- Added nested symbols for struct members, bitstruct members, enum values,
  constdef values, interface methods, function parameters, macro parameters, and
  attribute parameters.
- Added documentation, attribute, return type, parameter, and declaration body
  metadata to extracted symbols.
- Added syntax diagnostics for tree-sitter parse errors.
- Added recursive document symbols for nested C3 declarations.
- Added versioning workflow documentation for changelog, SemVer bumps, checks,
  commits, and tags.

### Changed

- Documented `npm test` and the current test coverage in project docs.
- Resolved hover and definition lookups against nested symbols in the module
  index.

## [0.1.0] - 2026-04-25

### Added

- Added workspace-wide C3 file indexing on LSP initialization.
- Added project-local cross-file symbol lookup for definition and hover support.
- Added module-aware completions for direct, imported, and relative module prefixes.
- Added split C3 test data to cover same-module symbols across files.

### Changed

- Refactored the language server out of a single large file into parser, index,
  completion, reference, workspace, and type modules.
- Reduced `src/server.ts` to LSP lifecycle and request wiring.

### Fixed

- Re-index closed workspace documents from disk so closing an editor tab does
  not remove project symbols from cross-file navigation.
