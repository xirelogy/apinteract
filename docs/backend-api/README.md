# Backend Component API

The backend component API connects APInteract browser clients to the backend
that owns application data, authorization, sessions, and request
orchestration.

The canonical contract is the
[OpenAPI JSON document](openapi.json). It defines the HTTP operations and the
bounded WebSocket message schemas used by the web frontend.

## Transport Roles

- HTTP provides authentication, session refresh, health reporting, and exact
  response-body transfer.
- WebSocket provides authenticated commands, replies, and execution events.
- Binary payloads are transferred over HTTP rather than embedded in WebSocket
  JSON messages.

HTTP errors use RFC 9457 problem details. Machine-readable error codes remain
stable within a compatible API version, while clients also display the safe
human-readable fallback message.

The API version is `0.1.0`. API version changes require maintainer approval.
