# Proxy Authentication Configuration

The proxy uses configuration-backed bearer authentication for the MVP. Each
recognized token maps to a stable backend principal:

```yaml
authentication:
  bearerTokens:
    - principalId: backend_primary
      tokenSha256: "lowercase-sha256-of-a-high-entropy-token"
    - principalId: backend_staging
      tokenSha256: "lowercase-sha256-of-another-high-entropy-token"
```

A principal identifies an authorized backend instance. It does not identify an
APInteract application user. Execution ownership and per-principal limits use
`principalId`.

## Security Properties

- Tokens contain at least 32 cryptographically random bytes.
- Configuration stores lowercase SHA-256 token hashes rather than plaintext
  bearer tokens.
- Token hash comparison uses a constant-time operation.
- Several token hashes can map to the same principal during token rotation.
- Removing the old token hash completes rotation without changing ownership of
  existing executions.
- Principal identifiers are unique, stable, and contain no secrets.
- Configuration files have restrictive filesystem permissions.
- Logs, errors, execution metadata, and response frames exclude bearer tokens.
- Remote proxy communication uses TLS.

The proxy derives the principal only from successful bearer authentication.
API requests contain no field that provides or overrides a principal
identifier.
