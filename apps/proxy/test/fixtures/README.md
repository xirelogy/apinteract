# TLS test fixture

`localhost-cert.pem` and `localhost-key.pem` form a self-signed certificate pair
used only by proxy transport tests. The private key is deliberately public test
material committed for deterministic TLS metadata and rejection tests. It must
never be used by an APInteract deployment or any service outside the test
suite.

The historical Gitleaks finding for this exact key is excluded by fingerprint
in the repository's `.gitleaksignore`. The exception does not allow another
private key at this path.
