# Release Versioning

The root `package.json` version is the authority for this repository.

Current frozen platform core version:

```text
0.8.0
```

Rules:

- All first-party workspace package versions must match the root version.
- `.env.example` `APP_VERSION` must match the root version.
- README and `docs/CURRENT_STATUS.md` must display the same version.
- `CHANGELOG.md` must contain an entry for the root version.
- `corepack pnpm version:check` enforces these checks.

Version line:

- AR-1 Platform Core: `0.8.0`
- AR-2 Intelligence RC: `0.9.0-rc.x`
- V1 GA: `1.0.0`

Do not create tags from automation in this repository task flow. Human release commands should be run only after reviewing the final diff and live smoke evidence.
