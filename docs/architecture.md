# Architecture

This project is a TypeScript LSP server for C3. The main design goal is to keep
editor protocol wiring, syntax extraction, project indexing, semantic analysis,
and LSP feature formatting separate enough that each layer can evolve without
forcing broad changes through the server entrypoint.

## Runtime Flow

```text
editor / LSP client
  -> src/server.ts
  -> src/server/          initialization, capability, and environment helpers
  -> src/workspace/       scan/watch files and feed parsed documents
  -> src/parser/          tree-sitter parse and C3 symbol extraction
  -> src/project/         module index, imports, symbol and member resolution
  -> src/analysis/        diagnostics and lightweight semantic checks
  -> src/lsp/             LSP-specific result shaping
```

`src/server.ts` owns process lifecycle and request registration only. Helpers in
`src/server/` keep transport detection, initialization capability declarations,
workspace roots, stdlib roots, and path normalization out of LSP feature code.

## Module Boundaries

- `src/parser/` converts C3 source text into `ParsedDocument` data. It should not
  depend on LSP request handlers or workspace scanning.
- `src/project/` owns indexed module state and resolver queries. It can depend on
  parser output and shared type utilities, but should avoid formatting LSP
  responses.
- `src/analysis/` produces semantic facts and diagnostics from parsed documents
  and the project index. Shared helpers in this layer keep conservative
  expression type inference and mismatch checks reusable across return, call,
  assignment, condition, and declaration diagnostics.
- `src/lsp/` turns parsed/indexed data into protocol objects. Cursor/context
  parsing that is specific to a feature lives next to that feature, such as
  `completion-context.ts`.
- `src/workspace/` handles filesystem discovery and watching. It should feed the
  index instead of resolving symbols itself.
- `src/toolchain/` wraps external C3 tools. Server code decides when to run those
  tools; feature modules should not shell out directly.

## Dependency Direction

Keep dependencies flowing inward:

```text
server -> workspace/toolchain/lsp -> analysis/project/parser -> shared
```

Avoid importing `src/server.ts` from any module. Avoid making `project-index`
format LSP-specific objects unless the object is part of a stable shared
contract, such as `Location` or `Range` used throughout the server.

## Current Refactor Priorities

1. Keep shrinking `src/server.ts` into lifecycle and request registration.
2. Split `ProjectIndex` into module storage, import/module resolution, scoped
   symbol resolution, and lightweight type analysis once behavior is covered by
   tests.
3. Keep completion context parsing separate from completion item creation so
   future completion modes can be added without expanding one large function.
4. Prefer shared helpers for edits and protocol boilerplate when multiple LSP
   features produce the same edit shape, such as import insertion.
