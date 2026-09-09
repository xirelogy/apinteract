# Backend Component API

The backend component API connects APInteract browser clients to the backend
that owns application data, authorization, sessions, and request
orchestration.

The canonical contract is the
[OpenAPI JSON document](openapi.json). It defines the HTTP operations and the
bounded WebSocket message schemas used by the web frontend.

Deployment settings, defaults, accepted values, and the AIO override boundary
are documented in the [backend configuration reference](configuration.md).

## Transport Roles

- HTTP provides first-user setup, authentication, session refresh, health
  reporting, exact response-body transfer, and execution-scoped certificate
  download.
- WebSocket provides authenticated commands, replies, and execution events.
- Cookie-jar WebSocket commands explicitly address a workspace-default or
  environment partition and expose its delete and clear controls. Cookie
  concurrency is a user execution default rather than jar state. Values are
  returned only after workspace authorization and never enter the proxy API.
- The backend sends a native WebSocket ping every 25 seconds and expects a
  pong, keeping idle connections alive through common ingress timeouts and
  terminating peers that no longer respond.
- Binary payloads are transferred over HTTP rather than embedded in WebSocket
  JSON messages.

HTTP errors use RFC 9457 problem details. Machine-readable error codes remain
stable within a compatible API version, while clients also display the safe
human-readable fallback message.

The API version is `0.1.1`. API version changes require maintainer approval.
