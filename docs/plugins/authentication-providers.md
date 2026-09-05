# Authentication Provider Plugins

APInteract authentication providers add login methods while preserving one
application-user, authorization, and session model. The extension contract
supports local passwords and future email, OTP, OIDC, LDAP, and other methods.

The authentication-provider contract is available in `@apinteract/plugin-api`
1.1.0. The package is additive to the published 1.0.0 plugin API contract.
APInteract currently ships one built-in provider, `builtin.local-password`.

## System Boundary

Authentication providers prove a provider-scoped identity:

```text
provider plugin
  -> verified provider assertion

APInteract identity service
  -> linked login credential
  -> application user

APInteract session service
  -> short-lived access JWT
  -> opaque refresh credential
```

Only authentication is pluggable. APInteract retains ownership of users,
credential linkage, account status, roles, capabilities, sessions, token
claims, refresh rotation, and revocation. A provider cannot create permissions
or issue APInteract session credentials.

## Provider Packages And Instances

An installed provider package defines a provider type. Administrators create
one or more configured instances of that type. This allows one LDAP plugin to
connect to several directories, or one OIDC plugin to represent several
issuers, without sharing subject namespaces.

Enabled instances are an ordered startup configuration allowlist. Each entry
has a switching key, user-facing label, built-in plugin ID, and plugin-specific
configuration:

```yaml
authentication:
  providers:
    - id: local-password
      plugin: builtin.local-password
      label: Username and password
      description: Sign in with your APInteract username and password.
      configuration: {}
```

Restart APInteract after changing this list. The `id` identifies the instance
in login flows and credential administration; it is independent of the
APInteract username and of the provider's own subject identifier. Omitting the
section enables the single local-password instance shown above.

Auth provider packages use the built-in plugin layout:

```text
/opt/apinteract/plugins/
  example-provider/
    apinteract-plugin.json
    dist/
      backend.mjs
      frontend.mjs
```

The package manifest identifies its version, matched backend and frontend
entrypoints, and declared authentication contributions. Authentication bundles
are shipped only in the read-only built-in plugin root; user plugin roots
cannot supply code to the anonymous login surface.

Installed providers are trusted backend code. The contract limits coupling but
does not sandbox an extension.

## Provider Anatomy

One provider package can contain:

```text
descriptor
interaction flows
optional credential handler
external-service requirements
```

The provider implements only the facets its method needs. A local password
provider has a credential handler but no external dependency. An OIDC provider
has redirect and callback interactions but may not store provider tokens.

### Descriptor

Provider descriptors expose:

```text
plugin identity and version
authentication contract version
administrator configuration schema
available authentication flows
credential-management capabilities
required delivery or network services
```

Provider configuration can contain secret references. Configuration secrets
are deployment data and are not workspace variables.

### Interaction Flows

The package's matched frontend contribution owns its provider-specific login
experience. APInteract mounts it in a host-provided container and supplies only
the instance's safe public descriptor and narrow actions for starting,
continuing, cancelling, and completing authentication. This permits password,
multi-step code, redirect, passkey, and other browser-native interactions
without exposing application or session internals.

The host remains responsible for attempt expiry, browser binding, Origin and
CSRF validation, replay prevention, rate limiting, session establishment, and
navigation. Provider frontend code does not receive access or refresh
credentials, private backend configuration, token storage, or a general
backend client. Sensitive values are excluded from ordinary logs and automatic
persistence.

### Credential Data

Provider data has three lifecycles:

| Data                   | Example                    | Lifetime                   |
| ---------------------- | -------------------------- | -------------------------- |
| Instance configuration | LDAP URL or OIDC client ID | Until administrator change |
| Credential material    | Password hash or TOTP seed | Until credential removal   |
| Attempt state          | OTP hash or PKCE verifier  | One short-lived attempt    |

Providers define schemas for credential material and attempt state. APInteract
persists those records through its database-independent repositories, so
providers do not depend on SQLite, PostgreSQL, or MySQL tables.

Providers must return only storage-safe credential material. Password providers
apply a password-specific one-way hash such as Argon2id; raw passwords and
other transient login evidence are never stored as credential material.

### Runtime Flow

A provider runtime handles a small state machine:

```text
begin
continue
cancel
health
```

Each invocation produces one of:

```text
interaction required
authenticated
rejected
temporarily unavailable
```

APInteract stores protected attempt state between invocations and owns the
public start, continue, cancellation, and callback routes. Provider packages do
not add arbitrary authentication endpoints.

Credential-capable providers can implement creation and update operations. The
built-in administration and recovery commands use the local-password
provider's credential handler.

## External Services

Provider runtimes receive scoped backend services for time, secure randomness,
password hashing, and credential lookup. Future providers that require
callbacks or outbound communication will need additional narrow host services;
they do not receive unrestricted application services.

Email and SMS delivery are separate extension points. Email-link and OTP
providers request delivery through those services instead of embedding one
specific SMTP or SMS implementation.

OIDC integrations use state, PKCE, nonce, and callback binding. OAuth2 without
an identity layer is suitable only when the integration obtains and verifies a
stable provider-specific subject.

LDAP integrations use protected directory connections and stable identifiers
such as `entryUUID` or `objectGUID`. APInteract does not persist LDAP bind
passwords.

## Provider Assertions

Successful providers return a bounded assertion:

```text
provider instance
stable subject
authentication time
authentication methods
optional assurance level
safe profile claims
```

APInteract resolves that assertion to a linked login credential and user.
Profile claims do not grant roles and matching email addresses do not merge
users automatically.

After identity resolution, every provider enters the same session service.
The browser receives a short-lived bearer access JWT, while refresh uses a
rotating opaque HTTP-only cookie. Provider packages have no access to token
signing or refresh state.

## Example Providers

| Provider       | User interaction           | Persistent provider data          | External system |
| -------------- | -------------------------- | --------------------------------- | --------------- |
| Local password | Username and password      | Username lookup and password hash | None            |
| Email code     | Email followed by code     | Verified email subject            | Email delivery  |
| Login link     | Email followed by callback | Verified email subject            | Email delivery  |
| SMS OTP        | Phone followed by code     | Verified phone subject            | SMS delivery    |
| TOTP           | One-time code              | Encrypted TOTP seed               | None            |
| OIDC           | Browser redirect           | Issuer-bound subject link         | OIDC endpoints  |
| LDAP           | Username and password      | Stable directory subject          | LDAP directory  |

Raw passwords, one-time codes, login-link tokens, OAuth authorization codes,
and LDAP bind credentials are transient evidence rather than persistent
credential material.

## Built-In Password Provider

The MVP includes `builtin.local-password`. Its frontend contribution provides
username/password interaction, while its backend contribution provides
Argon2id credential storage, administrator credential creation and reset,
generic authentication failures, and provider assertions consumed by the
standard identity and session services.

If exactly one local-password instance is configured, `apinteract-admin init`
and `apinteract-admin reset-password USER` select it automatically. When
several local-password instances exist, pass `--provider-instance ID` to the
backend administrator command. These practices belong specifically to the
local-password provider and are not implied for other login methods.

Authentication bundles are currently built-in only. User-installed plugin
roots remain available for ordinary frontend and backend plugins, but cannot
add code to the anonymous login surface.
