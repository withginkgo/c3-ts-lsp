# Changelog

All notable project changes are recorded here.

## [Unreleased]

### Added

- Added a Node test runner setup with TypeScript type-checking for tests.
- Added parser, project-index, and completion tests for the current LSP
  prototype behavior.
- Added versioning workflow documentation for changelog, SemVer bumps, checks,
  commits, and tags.

### Changed

- Documented `npm test` and the current test coverage in project docs.

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
