# Secrets handling

| Rule | Mechanism |
| --- | --- |
| No secrets in git | `.gitignore` excludes `.env*` except `.env.example`; `pnpm check:secrets` + `backend/tests/security/repo-hygiene.test.ts` fail the build on secret-looking literals or env/key files; enable GitHub secret scanning + push protection on the repository |
| Development | `infrastructure/scripts/setup-dev.sh` generates `.env` with a random DB password (file mode 600) |
| CI | No secret literals in workflows. The CI database is an ephemeral service container using trust auth. Real secrets (when needed later) go in GitHub Actions encrypted secrets, scoped to environments |
| Production | Injected as environment variables from the platform secret manager; never baked into images |
| In memory | Config exposes secrets as `Secret` objects that print as `[REDACTED]`; call `.reveal()` only where the value is used |
| Logs | Pino redaction paths + request logs without headers/bodies/query strings (`logger-options.ts`, tested) |
| Errors | Config errors name the variable, never the value (tested) |
| Rotation | Any suspected leak: rotate immediately, then purge from git history |
