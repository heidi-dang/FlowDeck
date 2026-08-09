# v2 configuration

Routing is opt-in and conservative:

```jsonc
{
  "routing": {
    "enabled": true,
    "mode": "shadow"
  },
  "tokenBudget": {
    "enabled": true,
    "profile": "normal"
  }
}
```

Allowed routing modes are:

- `off`: no routing assessment is calculated;
- `shadow`: decisions are calculated, persisted, and measured without controlling execution;
- `enforce`: an explicit readiness gate must pass before a current decision becomes an execution plan. Missing prerequisites fall back safely and do not switch the model/provider.

The token-budget controller is the only budget authority. FDX persistence is optional and bounded; native FDX and TypeScript fallbacks remain available when the daemon is absent. Set `FLOWDECK_FDX_DAEMON=on` to start the optional structured local daemon for persistent search, outline, and impact requests. A daemon start failure or timeout falls back without blocking OpenCode.
