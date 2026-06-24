# scripts

Only thin repository wrappers live here. Command logic belongs in `devtools/repo-cli`.

Preferred entry point:

```bash
pnpm dar --help
```

The shell scripts in this directory either call `pnpm dar ...` or wrap Docker build/run commands.
