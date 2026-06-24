# repo-cli

`@dar/repo-cli` is the development-only command surface for repository checks, local operations, replay export, and smoke orchestration.

It is not a production app, does not listen on a port, and must not be imported by production apps.

Common commands:

```bash
pnpm dar check all
pnpm dar smoke list
pnpm dar smoke suite core
pnpm dar replay test
```
