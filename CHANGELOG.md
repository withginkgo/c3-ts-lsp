# Changelog

All notable project changes are recorded here.

## [Unreleased]

### Added

- Added a structured resolver result with selected symbol, candidates, and
  resolution status for position-aware symbol lookup.
- Added configurable standard library indexing through LSP initialization
  options and C3 standard-library environment variables.
- Added hover and definition handling for ambiguous symbol candidates.
- Added richer hover output with full aggregate details, owning aggregate
  context for members, and resolved type context for variables.
- Added workspace file watching so changed, created, and deleted C3 source
  files update the project index without restarting the server.
- Added module alias and relative import resolution for hover, definition, and
  module-prefix completions.
- Added semantic diagnostics for unresolved imports, unresolved module alias
  targets, unresolved expression symbols, and ambiguous expression symbols.
- Added member access resolution for struct members, including pointer-like
  receiver types.
- Added basic expression type inference for chained members, call return values,
  array/subscript receivers, parenthesized expressions, and simple unary
  pointer-style expressions.
- Added basic overload narrowing by call arity and literal argument type.
- Added local, parameter, and member-aware completions.
- Added member completions for incomplete member access such as `res.`.
- Added an LSP references provider backed by syntax-tree references and symbol
  resolution.
- Added type usage references for type declarations.
- Added workspace symbols for indexed project declarations and nested members.
- Added signature help for function and macro calls.
- Added rename support with workspace edits for non-stdlib symbols.
- Added code actions for missing imports and unresolved import cleanup.
- Added semantic tokens for declaration-oriented highlighting.
- Added inlay type hints for simple inferred `var` declarations.
- Added optional document formatting through a configured external formatter.

### Changed

- Made position-aware hover and definition avoid unrelated global module
  fallback and report ambiguous imported symbols instead of silently selecting
  the first match.
- Made unqualified completions include visible imported symbols while excluding
  unrelated modules and private imported declarations.
- Made project index updates rebuild only affected modules during single-file
  changes.
- Made standard library files participate in resolution without publishing
  diagnostics for those read-only files.
- Made hover, definition, diagnostics, and references distinguish struct
  members from unrelated top-level symbols.
- Made member completions use the receiver expression before the cursor, so
  existing member text after the cursor does not change the suggested members.
- Made qualified references such as `net::connect` track the terminal symbol
  range so rename edits preserve the module prefix.
- Made C3 type methods such as `fn void EventLoop.init(&self)` bind `self` to
  the receiver type and participate in member resolution.
- Made member resolution derive a nominal base type from generic receiver types
  such as `HashMap{K, V}` and `List{T}` before matching type methods.

### Fixed

- Recovered top-level callable symbols from parser-error regions so newer C3
  standard-library macros such as `io::printn` remain resolvable.
- Fixed unresolved diagnostics for `self.member` inside C3 type methods.
- Fixed unresolved diagnostics for method calls on generic fields such as
  `self.handlers.init()` and `self.polls.init()`.

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
