# C3 LSP Roadmap

This document records the current state of the language server and the modules
needed to move it from prototype to a generally usable C3 LSP.

## Current State

The server currently provides a working prototype:

- Tree-sitter based parsing for C3 source text.
- Workspace scanning for `.c3`, `.c3i`, and `.c3t` files.
- A module index keyed by `module` declarations.
- Top-level symbol extraction for functions, structs, enums, interfaces,
  fault definitions, constants, globals, and macros.
- Basic hover, definition, document symbols, and completions.
- Small debug scripts for parser tree and symbol inspection.

The implementation is intentionally shallow. It indexes top-level declarations
and resolves symbols mostly by name. It does not yet model lexical scopes,
member declarations, overloads, type relationships, diagnostics, or editor
packaging.

## Target Architecture

```text
src/server.ts              LSP process entrypoint and request wiring
src/lsp/                   LSP feature handlers and document helpers
src/parser/                Tree-sitter parsing and C3 syntax extraction
src/project/               Workspace module index and symbol resolution
src/workspace/             File discovery, file watching, workspace lifecycle
src/shared/                Shared data contracts
src/tools/                 Local debug and inspection utilities
testdata/                  C3 fixtures used by tests and debug scripts
docs/                      Design notes, roadmap, and troubleshooting logs
```

As the server grows, the next split should be between syntax extraction and
semantic analysis:

```text
src/analysis/              Scopes, types, references, diagnostics
src/features/              Optional high-level LSP feature composition
tests/                     Unit and integration test harness
```

## Implementation Phases

### Phase 0: Project Baseline

Goal: make the repository easy to modify safely.

- Add a test runner and fixture-based tests for parser extraction and module
  resolution.
- Add lint/format scripts and keep build output out of source control.
- Keep debug tools, README, and troubleshooting docs aligned with the source
  layout.

Exit criteria:

- `npm run build` passes.
- Parser and project-index behavior is covered by repeatable tests.
- A new contributor can find the entrypoint, parser, index, and LSP handlers
  without reading every file.

### Phase 1: Syntax Coverage

Goal: extract a complete, stable syntax model from tree-sitter.

- Cover all top-level C3 declarations supported by the grammar.
- Extract struct/union/interface members, enum values, function parameters,
  return types, attributes, docs/comments, and macro signatures.
- Preserve source ranges for every declaration name and body.
- Detect tree-sitter parse errors and expose them as syntax diagnostics.

Exit criteria:

- Document symbols show useful nested symbols.
- Hover can show signatures for members, parameters, constants, and enum values.
- Parser fixtures protect every declaration kind the server claims to support.

### Phase 2: Project And Module Resolver

Goal: resolve names according to C3 project/module rules instead of global
name fallback.

- Model imports, aliases, relative module paths, public/private visibility, and
  duplicate module files.
- Track workspace folders and update the index when files are created, changed,
  renamed, or deleted.
- Add a resolver API that returns all candidates plus the selected candidate.
- Add deterministic tie-breaking and diagnostics for ambiguous symbols.

Exit criteria:

- Go-to-definition works reliably across imported modules.
- Completion is module-aware and avoids unrelated global symbols.
- Index rebuilds are incremental enough for medium workspaces.

### Phase 3: Scope And Type Analysis

Goal: make references, hover, and completions context-aware.

- Build lexical scopes for modules, functions, blocks, parameters, locals, and
  members.
- Resolve identifiers from inner scope to module/import scope.
- Track basic type information for declarations and expressions.
- Support member access, pointer/member dereference, namespace-qualified names,
  and overload candidates.

Exit criteria:

- Hover/definition distinguish locals, parameters, members, and top-level
  symbols with the same name.
- Completion can suggest locals, parameters, module symbols, and members based
  on cursor context.
- References can be implemented without broad text search.

### Phase 4: Diagnostics

Goal: make the server useful during editing, not only navigation.

- Publish syntax diagnostics from tree-sitter parse errors.
- Publish semantic diagnostics for unresolved imports, unresolved symbols,
  duplicate declarations, ambiguous references, and invalid member access.
- Optionally integrate `c3c` diagnostics when a compiler executable is
  configured.
- Debounce diagnostics and avoid publishing stale results.

Exit criteria:

- Editors show useful errors while typing.
- Diagnostics clear correctly when files close, change, or are deleted.
- Compiler-backed diagnostics are optional and do not block core LSP features.

### Phase 5: Core LSP Features

Goal: cover the features expected from a daily-use language server.

- Workspace symbols and references.
- Signature help for function and macro calls.
- Rename with workspace edits.
- Code actions for missing imports and simple quick fixes.
- Semantic tokens for syntax highlighting support.
- Inlay hints for inferred or hard-to-see types if C3 patterns benefit from
  them.
- Formatting through an external formatter if the C3 toolchain provides one.

Exit criteria:

- The server supports navigation, completion, diagnostics, references, rename,
  and signature help across a normal workspace.
- Feature tests cover both single-file and multi-file projects.

### Phase 6: Editor Packaging And Release

Goal: make installation and debugging practical.

- Add a VS Code extension wrapper or documented client configuration.
- Document Neovim/Helix/Zed client setup if those are target editors.
- Add CI for install, build, and tests on supported Node versions.
- Version releases and changelog entries consistently.

Exit criteria:

- Users can install the server and connect it to an editor without local
  TypeScript knowledge.
- Releases are reproducible from clean checkout.

## Module Backlog

| Module | Purpose | Priority |
| --- | --- | --- |
| `tests/` | Unit and LSP integration test harness | P0 |
| `src/analysis/scope.ts` | Lexical scope tree | P1 |
| `src/analysis/resolver.ts` | Identifier and module resolution | P1 |
| `src/analysis/types.ts` | Lightweight type model | P2 |
| `src/analysis/diagnostics.ts` | Syntax and semantic diagnostics | P1 |
| `src/lsp/references.ts` | Reference provider | P2 |
| `src/lsp/signature-help.ts` | Signature help provider | P2 |
| `src/lsp/rename.ts` | Rename provider | P3 |
| `src/lsp/semantic-tokens.ts` | Semantic token provider | P3 |
| `src/lsp/code-actions.ts` | Quick fixes and import actions | P3 |
| `src/workspace/watch.ts` | File watching and incremental index updates | P1 |
| `src/toolchain/c3c.ts` | Optional compiler diagnostic integration | P2 |

## Recommended Next Steps

1. Add tests around `parseSource`, `ProjectIndex.findSymbol`, and completion.
2. Add syntax diagnostics from tree-sitter error nodes.
3. Replace global fallback resolution with a resolver that understands scopes
   and imports.
4. Expand parser extraction to members, parameters, enum values, and docs.
5. Add references and signature help after the resolver is stable.
