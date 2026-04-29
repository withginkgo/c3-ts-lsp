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
- Added return-flow semantic diagnostics for missing return values, unexpected
  values from `void` functions, obvious return type mismatches, and non-void
  functions that can fall through.
- Added broader lightweight semantic diagnostics for unresolved type
  references, duplicate declarations/members/parameters/locals, missing
  interface method implementations, obvious call argument type mismatches,
  initializer/assignment type mismatches, and non-boolean conditions.
- Added optional-result semantic diagnostics for discarded optional calls,
  optional-to-non-optional return/initializer/assignment flows, optional
  arguments that make a discarded call result optional, invalid `void?`
  variables, optional `main` returns, and discarded `@nodiscard` calls.
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
- Added signature help fallback for incomplete function and method-style calls
  while editing.
- Added rename support with workspace edits for non-stdlib symbols.
- Added code actions for missing imports and unresolved import cleanup.
- Added semantic tokens for declaration-oriented highlighting.
- Added inlay type hints for simple inferred `var` declarations.
- Added optional document formatting through a configured external formatter.
- Added import and module-alias path completions for indexed workspace,
  dependency, and standard-library modules.
- Added auto-import completions for unimported public symbols, with
  `additionalTextEdits` inserting the required import.
- Added architecture documentation for module boundaries, dependency direction,
  and the next refactor priorities.
- Added npm format scripts and a Prettier ignore file for generated or local
  workspace artifacts.

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
- Made the project index honor conservative `module ... @if(env::...)`
  conditions, so inactive standard-library platform branches do not create
  ambiguous symbols such as `NativeSocket` from both POSIX and Win32 modules.
- Made hover, definition, diagnostics, and references distinguish struct
  members from unrelated top-level symbols.
- Made member completions use the receiver expression before the cursor, so
  existing member text after the cursor does not change the suggested members.
- Made qualified references such as `net::connect` track the terminal symbol
  range so rename edits preserve the module prefix.
- Made C3 type methods such as `fn void EventLoop.init(&self)` bind `self` to
  the receiver type and participate in member resolution.
- Made diagnostics keep running recoverable semantic checks outside syntax-error
  ranges, so later incomplete syntax no longer hides earlier optional-result,
  type, call, and declaration diagnostics.
- Made member resolution derive a nominal base type from generic receiver types
  such as `HashMap{K, V}` and `List{T}` before matching type methods.
- Made recovered callables from parser-error regions preserve C3 receiver
  types, so stdlib methods on `HashMap`, `List`, and similar generic
  containers participate in member resolution.
- Made type-method lookup follow imported module dependencies when resolving
  receiver methods such as `NativeSocket.set_non_blocking` exposed through
  `std::net`.
- Split reusable expression type inference and mismatch checks out of return
  diagnostics so semantic diagnostics share one conservative type-analysis
  path.
- Made expression type inference preserve outer optional markers, unwrap common
  `!`, `!!`, and `??` flows, and propagate optional arguments through call
  result types.
- Renamed the package from the template placeholder to `c3-ts-lsp`.
- Split server capability declarations and environment/path resolution out of
  the LSP entrypoint.
- Split completion cursor/context parsing out of completion item generation.

### Fixed

- Fixed unresolved diagnostics for local `const` declarations used inside
  compile-time assertions and other expressions.
- Recovered top-level callable symbols from parser-error regions so newer C3
  standard-library macros such as `io::printn` remain resolvable.
- Fixed unresolved diagnostics for `self.member` inside C3 type methods.
- Fixed unresolved diagnostics for method calls on generic fields such as
  `self.handlers.init()` and `self.polls.init()`.
- Fixed unresolved diagnostics for recovered stdlib receiver methods used
  through generic fields, including `self.handlers.set(...)`,
  `self.polls.push(...)`, and `sock.sock.set_non_blocking(...)`.
- Fixed attributes on top-level function declarations so declaration-only
  callables honor annotations such as `@maydiscard`.

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
