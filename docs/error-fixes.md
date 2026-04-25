# Error Fix Log

## 2026-04-25

### TypeScript module resolution errors

Symptoms:

```text
Cannot find module 'tree-sitter-c3' or its corresponding type declarations.
Cannot find module 'vscode-languageserver/node' or its corresponding type declarations.
```

Cause:

The project is configured as Node ESM with `module` and `moduleResolution` set
to `NodeNext`. In that mode, TypeScript and Node require ESM-compatible package
entry points and file extensions.

Fix:

- Import `tree-sitter-c3` through its concrete ESM entry:
  `tree-sitter-c3/bindings/node/index.js`.
- Import the language server node entry as `vscode-languageserver/node.js`.
- Keep `tsconfig.json` focused on the Node language server output:
  `rootDir: "src"` and `outDir: "dist"`.

### Debug script path error

Symptoms:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'src/debug-symbols.ts'
```

Cause:

The script pointed at `src/debug-symbols.ts`, while the source file had a
different name during the initial edits.

Fix:

Use the normalized file name `src/debug-symbols.ts` and keep
`npm run debug:symbols` aligned with it.

### LSP startup crash

Symptoms:

```text
Error: Connection input stream is not set.
Use arguments of createConnection or set command line parameters:
'--node-ipc', '--stdio' or '--socket={number}'
```

Cause:

`vscode-languageserver` requires an explicit transport. Running
`node dist/server.js` without `--stdio`, `--node-ipc`, or socket arguments did
not provide an input or output stream.

Fix:

- Run `npm start` as `node dist/server.js --stdio`.
- Run `npm run dev` as `tsx src/server.ts --stdio`.
- Add a code fallback so direct `node dist/server.js` defaults to
  `process.stdin` and `process.stdout` when no transport argument is present.

### Vite template cleanup

Symptoms:

The project still contained Vite/WebStorm template references, including a Vite
type reference and front-end template assets, after the package had been changed
into a Node language server.

Fix:

- Remove the unused Vite type entry from `src`.
- Exclude legacy `public/` template assets from Git.
- Regenerate `package-lock.json` so it matches the current `package.json`
  dependencies.
