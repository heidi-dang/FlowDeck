# Upgrade

## From npm

```bash
npx @heidi-dang/flowdeck@latest install
```

The `install` command updates the plugin registration. Restart OpenCode to activate the new version.

## From Local Repository

```bash
cd /path/to/FlowDeck
git pull origin main
npm install
npm run build
```

OpenCode loads the updated code from the local checkout path on next restart.

## From Upstream (@dv.nghiem/flowdeck)

```bash
npx @heidi-dang/flowdeck migrate
```

This replaces `@dv.nghiem/flowdeck` references with `@heidi-dang/flowdeck` and sets `default_agent` to `heidi` if not already configured.

## Post-Upgrade Verification

```bash
flowdeck verify
flowdeck doctor
```

## Rollback

If an upgrade causes issues, roll back to the previous configuration:

```bash
flowdeck rollback
```

This restores the backup created before the last mutation.
