# Versioning

This project uses SemVer-style package versions and changelog entries.

## Version Sources

- `package.json` is the source of the package version.
- `package-lock.json` must carry the same root package version after a release
  bump.
- `CHANGELOG.md` records user-visible and contributor-visible changes.
- Git commits and tags record the release history.

## Version Policy

- Patch version: bug fixes, diagnostics fixes, editor compatibility fixes,
  internal cleanup, tests, and docs.
- Minor version: new LSP capabilities, new parser coverage, new editor
  integrations, or new configuration options that remain backward compatible.
- Major version: breaking CLI, protocol, configuration, Node runtime, or package
  layout changes.

Before the language server reaches a stable `1.0.0`, minor versions can still
carry meaningful behavior changes, but breaking changes should be called out in
the changelog.

## Development Workflow

1. Make the code or documentation change.
2. Add tests for changed parser, resolver, index, or LSP behavior.
3. Run `npm run check`.
4. Add an entry under `## [Unreleased]` in `CHANGELOG.md`.
5. Commit with a conventional message such as `feat:`, `fix:`, `test:`,
   `docs:`, or `chore:`.

## Release Workflow

1. Decide the next SemVer version.
2. Run one of:

   ```bash
   npm version patch --no-git-tag-version
   npm version minor --no-git-tag-version
   npm version major --no-git-tag-version
   ```

3. Move `CHANGELOG.md` entries from `Unreleased` into a dated release section.
4. Run `npm run check`.
5. Commit the release with `chore(release): <version>`.
6. Tag the commit with `v<version>`.

Example:

```bash
git tag v0.1.1
```
