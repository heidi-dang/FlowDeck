# FAQ

## What is FlowDeck?

FlowDeck is an OpenCode plugin that provides structured multi-agent orchestration, governance, and workflow capabilities. It extends OpenCode rather than replacing its core infrastructure.

## How does FlowDeck differ from the upstream (@dv.nghiem/flowdeck)?

The upstream FlowDeck by DVNghiem is the original project. This fork (`@heidi-dang/flowdeck`) adds:
- Installation ownership tracking and safe uninstall
- Pre-push verification gates (fast and full modes)
- TTY-aware stdin handling in the pre-push gate
- JSONC comment preservation through all mutations
- Transactional config mutation with rollback support

## Do I need Bun?

Only for development (building from source, running tests). The `install`, `verify`, and `doctor` commands work without Bun.

## Do I need Rust/Cargo?

No. FDX (Rust) tools are optional. All FDX tools have TypeScript fallbacks that work without the Rust binary.

## Does FlowDeck replace OpenCode?

No. FlowDeck is a plugin that extends OpenCode. OpenCode provides the core platform (model access, sessions, UI). FlowDeck adds orchestration and governance on top.

## How do I update the plugin reference?

```bash
flowdeck update
```

This updates stale or version-pinned references in your configuration.

## How do I switch from the upstream to this fork?

```bash
flowdeck migrate
```

This replaces `@dv.nghiem/flowdeck` references with `@heidi-dang/flowdeck`.

## How do I roll back a bad configuration change?

```bash
flowdeck rollback
```

This restores the most recent backup. Backups are created automatically before every configuration mutation.

## Will FlowDeck overwrite my existing OpenCode configuration?

FlowDeck uses transactional config mutation:
- It reads and validates the existing configuration first.
- It computes only the necessary edits.
- It creates a backup before writing.
- It does not modify malformed configurations.
- It never removes pre-existing plugin entries.

## How do I report a bug?

Open an issue at [github.com/heidi-dang/FlowDeck/issues](https://github.com/heidi-dang/FlowDeck/issues).

## How do I request a feature?

Open an issue with the `enhancement` label.

## Can I contribute?

Yes. See the [Development guide](Development.md).
