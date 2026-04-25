# C3 TypeScript Language Server

This project is a Node-based language server prototype for C3. It uses
`tree-sitter-c3` to parse C3 source files and `vscode-languageserver` to expose
document symbols, hover, definition, and completion support over LSP.

## Scripts

```bash
npm run build
npm start
npm run dev
npm run debug:tree
npm run debug:symbols
```

`npm start` runs the compiled server with `--stdio`. Directly running
`node dist/server.js` is also supported and defaults to stdio when no transport
argument is supplied.

## Notes

The server is an LSP process, not a normal CLI. When it starts successfully it
waits for JSON-RPC messages from an editor or LSP client, so no terminal output
is expected during idle startup.
