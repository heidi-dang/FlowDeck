## Summary

Atomic FlowDeck Clean Reinstall, Runtime Verification, and npm Release Alignment

## Changes

### Installer (feat)
- **Standalone piped bootstrap** (`install.sh`): works via `curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash` without requiring local checkout, `package.json`, or specific working directory
- **`flowdeck clean-install` CLI command**: full lifecycle with `--dry-run`, `--verify-only`, `--uninstall-only`, `--project`, `--local-repo`
- **Safe identity detection**: exact package name matching only (`@heidi-dang/flowdeck`, `@dv.nghiem/flowdeck`). No false positives for similarly-named packages, paths containing "flowdeck", or descriptions containing "flowdeck"
- **Transactional backup/rollback**: byte-for-byte backups via `config-transaction.mjs`, automatic rollback on any stage failure
- **Clean-state gate**: machine-readable verification before install
- **OpenCode runtime verification**: runs real `opencode --print-logs agent list` to confirm Heidi is primary and visible
- **Config scope discovery**: global, XDG, project, env var scopes with identity-safe cleanup
- **Installation lock**: prevents concurrent installer runs

### Documentation (docs)
- README: curl pipe installer as primary recommended method
- Installation.md: full piped installer lifecycle documentation
- Verification.md: 8-level verification procedure

### Release (chore)
- Version bump: 0.8.0-alpha.4 → 0.8.0-alpha.5
- package-lock.json aligned
- Release alignment checker script
- New npm scripts: `verify:release`, `install:clean`, `verify:clean-install`

## Verification

- [x] 1694 tests pass, 0 failures
- [x] Typecheck: clean
- [x] Lint: clean
- [x] Coverage: 81.36% (≥80% threshold)
- [x] Skills validation: passed
- [x] Docs validation: passed
- [x] Release alignment: version, exports, files array verified

## Testing

- 37 new installer tests (identity detection, transactions, rollback, piped installer structure)
- All existing tests continue to pass

## Notes

- Version 0.8.0-alpha.5 chosen because 0.8.0-alpha.4 is published with a different gitHead
- Published git tag follows standard `v<version>` pattern
- `latest` and `next` dist-tags will be aligned to release version after publication
