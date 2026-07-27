# Troubleshooting

## `flowdeck: command not found`

**Cause**: The CLI binary is not in PATH.

**Solutions**:
- For npm installations: ensure `%APPDATA%/npm` (Windows) or the npm global bin directory (Unix) is in your PATH.
- For local-repo installations: use `node bin/flowdeck.js` instead of `flowdeck`.
- Restart your terminal after installation.

## OpenCode cannot find FlowDeck

**Cause**: The plugin is registered but OpenCode cannot resolve the package.

**Solutions**:
- For npm installations: run `npx @heidi-dang/flowdeck install` to re-register.
- For local-repo installations: run `bash install.sh --local-repo` to update the `file://` reference.
- Check that the plugin entry exists in `opencode.json`.

## Plugin missing from opencode.json

**Cause**: Install command was not run, or uninstall removed the entry.

**Solutions**:
- Run `flowdeck install` to add the plugin entry.
- If the configuration file has been manually edited, add `"@heidi-dang/flowdeck"` to the `plugin` array.

## Malformed JSON or JSONC configuration

**Cause**: The configuration file contains syntax errors.

**Solutions**:
- FlowDeck preserves malformed files without mutation — fix the syntax error manually.
- Validate: `flowdeck config validate` reports the error location.
- Use a JSON validator or JSONC-aware editor to fix the file.

## `flowdeck verify` fails

**Cause**: One or more verification checks failed.

**Common failures**:

| Failure | Solution |
|---|---|
| `Package identity: NOT @heidi-dang/flowdeck` | Wrong package — check your installation source |
| `Global config: FlowDeck not registered` | Run `flowdeck install` |
| `Global config: points to upstream @dv.nghiem/flowdeck` | Run `flowdeck migrate` |

## Doctor reports missing runtime files

**Cause**: The build output (`dist/`) is missing or incomplete.

**Solutions**:
- Run `npm run build` from the FlowDeck directory.
- Ensure `dist/index.js` exists.

## Wrong OpenCode configuration directory

**Cause**: The `OPENCODE_CONFIG_DIR` environment variable points to a non-standard location.

**Solutions**:
- Set `OPENCODE_CONFIG_DIR` to the correct path.
- Check the current value: on Unix: `echo $OPENCODE_CONFIG_DIR` — on Windows: `echo %OPENCODE_CONFIG_DIR%`.

## Permission failure during install

**Cause**: Global npm installation requires write access to npm's global directory.

**Solutions**:
- On Unix: `sudo npm install -g @heidi-dang/flowdeck` (use with caution).
- Use `npx` instead: `npx @heidi-dang/flowdeck install`.
- Configure npm for local global packages.

## Stale or partial installation

**Cause**: A previous installation was interrupted.

**Solutions**:
- Run `flowdeck uninstall --force` to clean up.
- Reinstall with `flowdeck install`.

## Local package path contains spaces

**Cause**: The local repository path includes spaces but the installation method did not properly handle them.

**Solutions**:
- The `file://` URL format used by `--local-repo` handles spaces correctly.
- If you see issues, re-run: `bash install.sh --local-repo` or `node bin/flowdeck.js install --local-repo`.

## Windows executable-resolution failure

**Cause**: On Windows, Node.js cannot locate the executable for a `.cmd` or `.bat` wrapper.

**Solutions**:
- FlowDeck resolves executables via `process.execPath` or direct paths — this avoids `.cmd` wrappers.
- If you see `spawn EINVAL` errors, ensure you have the latest Node.js LTS installed.
- Use `node bin/flowdeck.js` directly instead of the `flowdeck` command.

## Bun unavailable

**Cause**: Running development commands that require Bun.

**Solutions**:
- Install Bun: `npm install -g bun` or follow [bun.sh](https://bun.sh) instructions.
- Development commands (`build`, `test`, `typecheck`) require Bun.
- The `install` and `verify` commands do NOT require Bun.

## Cargo unavailable for FDX development

**Cause**: Running Rust-related commands without Cargo installed.

**Solutions**:
- Install Rust: follow [rustup.rs](https://rustup.rs).
- FDX (Rust) is optional — FlowDeck works without it.
- Run `cargo build --manifest-path crates/fdx/Cargo.toml` from the FlowDeck directory.

## Uninstall ownership manifest missing

**Cause**: The `.flowdeck-manifest.json` file does not exist.

**Solutions**:
- Run `flowdeck uninstall --force` to remove the plugin entry without ownership tracking.
- Or manually remove `"@heidi-dang/flowdeck"` from the `plugin` array in `opencode.json`.

## Forced Uninstall

```bash
flowdeck uninstall --force
```

Use this only when the standard uninstall fails. `--force` removes only the exact plugin reference and never touches `default_agent`.
