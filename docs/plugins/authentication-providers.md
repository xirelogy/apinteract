# Authentication Provider Plugins

APInteract authentication providers add login methods while preserving one
application-user, authorization, and session model. The extension contract
supports local passwords and future email, OTP, OIDC, LDAP, and other methods.

This document describes the planned provider contract. Executable schemas and
the backend authentication OpenAPI operations will be published as backend
implementation begins.

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

External provider packages use the standard extension layout:

```text
/opt/apinteract/extensions/
  example-provider/
    apinteract-extension.json
    dist/
      entrypoint
```

The package manifest identifies its version, authentication contract version,
backend entry point, configuration schema, and required services. Extensions
are loaded at backend startup from an administrator-controlled, read-only
volume.

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

The frontend renders provider interactions from bounded descriptors rather
than provider-supplied HTML or JavaScript:

```text
InteractionStep
  kind:
    collect | redirect | await_callback | information
  fields:
    semantic:
      username | password | email | phone | otp | generic
    inputType:
      text | password | email | tel | otp
    validation and autocomplete metadata
    sensitive
```

A password flow collects username and password in one step. An email-code flow
first collects an email address, requests delivery, and then returns an OTP
step. An OIDC flow returns a redirect followed by a backend-owned callback.

The backend validates submitted field type and size before invoking the
provider. Sensitive values are excluded from ordinary logs and automatic
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

Private provider data is encrypted by APInteract before persistence. Password
providers additionally apply a password-specific one-way hash such as
Argon2id.

### Runtime Flow

A provider runtime handles a small state machine:

```text
begin
continue
handle callback
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

Credential-capable providers can also implement creation, update, removal, and
safe display operations. The built-in administration and recovery commands use
the same credential handler as normal backend APIs.

## External Services

Provider runtimes receive scoped backend services for time, secure randomness,
cryptography, callback URLs, credential lookup, and outbound communication.

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

The MVP includes `builtin.local-password`. It provides declarative
username/password collection, Argon2id credential storage, administrator
credential creation and reset, generic authentication failures, and provider
assertions consumed by the standard identity and session services.

The built-in implementation uses the same contract as external providers,
making the public extension boundary part of the initial backend architecture.
