import { createHash } from "node:crypto";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import type { Duplex } from "node:stream";
import type { LookupFunction, Socket } from "node:net";
import {
  checkServerIdentity,
  connect as tlsConnect,
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type TLSSocket,
} from "node:tls";

import type { components } from "@apinteract/api-contracts/proxy";

type ExecutionTimings = components["schemas"]["ExecutionTimings"];
type TargetRequest = components["schemas"]["TargetRequest"];
type TransportObservation = components["schemas"]["TransportObservation"];
type TlsAuthorizationErrorCode =
  components["schemas"]["TlsAuthorizationErrorCode"];
type TlsObservation = components["schemas"]["TlsObservation"];

const MAX_PEER_CERTIFICATES = 16;
const MAX_PEER_CERTIFICATE_DER_BYTES = 256 * 1_024;

interface SocketTlsObservation {
  readonly tls: TlsObservation;
  readonly connectMs: number;
  readonly tlsMs: number;
}

/** Result of opening one target response through the observed transport. */
export interface OpenedTargetResponse {
  readonly response: IncomingMessage;
  readonly transport?: TransportObservation;
  readonly timings: Omit<ExecutionTimings, "totalMs">;
}

/** Safe observed details retained when target transport establishment fails. */
export class TargetTransportError extends Error {
  readonly causeCode: string | undefined;
  readonly transport: TransportObservation | undefined;
  readonly timings: Omit<ExecutionTimings, "totalMs">;

  constructor(options: {
    readonly message: string;
    readonly causeCode?: string | undefined;
    readonly transport?: TransportObservation | undefined;
    readonly timings?: Omit<ExecutionTimings, "totalMs">;
  }) {
    super(options.message);
    this.causeCode = options.causeCode;
    this.transport = options.transport;
    this.timings = options.timings ?? {};
  }
}

interface OpenTargetOptions {
  readonly target: TargetRequest;
  readonly url: URL;
  readonly lookup: LookupFunction;
  readonly headers: Record<string, string | string[]>;
  readonly requestBody: Buffer;
  readonly startedAt: number;
  readonly dnsMs?: number | undefined;
  readonly collectObservations: boolean;
  readonly onRequest: (request: ClientRequest) => void;
}

/**
 * Opens pooled HTTP/1.1 target connections and captures execution observations.
 *
 * HTTPS agents delay handing a new socket to the HTTP client until the single
 * TLS handshake has been observed and, in strict mode, authorized. This
 * prevents request bytes from being sent on a diagnostically inspected but
 * unauthorized connection.
 */
export class TargetTransport {
  readonly #httpAgent = new HttpAgent({ keepAlive: true });
  readonly #strictHttpsAgent = new ObservedHttpsAgent("strict");
  readonly #insecureHttpsAgent = new ObservedHttpsAgent("insecure");

  /** Opens one target response with connection and response-head deadlines. */
  open(options: OpenTargetOptions): Promise<OpenedTargetResponse> {
    const {
      target,
      url,
      lookup,
      headers,
      requestBody,
      startedAt,
      dnsMs,
      collectObservations,
      onRequest,
    } = options;
    const https = url.protocol === "https:";
    const httpsAgent =
      target.behavior.tlsVerification === "strict"
        ? this.#strictHttpsAgent
        : this.#insecureHttpsAgent;
    const requestFunction = https ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      let socket: Socket | undefined;
      let connectionReused = false;
      let connectedAt: number | undefined;
      let connectMs: number | undefined;
      let responseHeaderTimer: NodeJS.Timeout | undefined;
      const connectStartedAt = performance.now();
      const connectTimer = setTimeout(() => {
        request.destroy(
          new TargetTransportError({
            message: "The target connection timed out.",
            causeCode: "APINTERACT_CONNECT_TIMEOUT",
            transport: observationForSocket(
              socket,
              connectionReused,
              collectObservations,
              https ? httpsAgent.observation(socket) : undefined,
            ),
            timings: phaseTimings(
              collectObservations ? dnsMs : undefined,
              collectObservations ? connectMs : undefined,
            ),
          }),
        );
      }, target.behavior.connectTimeoutMs);
      connectTimer.unref();

      const request = requestFunction(
        url,
        {
          method: target.method,
          headers,
          lookup,
          agent: https ? httpsAgent : this.#httpAgent,
        },
        (response) => {
          const responseSocket = response.socket;
          clearTimeout(connectTimer);
          if (responseHeaderTimer !== undefined) {
            clearTimeout(responseHeaderTimer);
          }
          const firstByteMs = performance.now() - startedAt;
          const tlsSocketObservation = https
            ? httpsAgent.observation(response.socket)
            : undefined;
          response.setTimeout(target.behavior.responseIdleTimeoutMs, () => {
            response.destroy(
              new TargetTransportError({
                message: "The target response became idle.",
                causeCode: "APINTERACT_RESPONSE_IDLE_TIMEOUT",
                transport: observationForSocket(
                  responseSocket,
                  connectionReused,
                  collectObservations,
                  tlsSocketObservation,
                ),
                timings: phaseTimings(
                  connectionReused ? undefined : dnsMs,
                  connectionReused || !collectObservations
                    ? undefined
                    : (tlsSocketObservation?.connectMs ?? connectMs),
                  connectionReused || !collectObservations
                    ? undefined
                    : tlsSocketObservation?.tlsMs,
                  firstByteMs,
                ),
              }),
            );
          });
          /** Clears the captured socket timer even after Node detaches it. */
          const clearIdleTimeout = (): void => {
            responseSocket.setTimeout(0);
          };
          response.once("end", clearIdleTimeout);
          response.once("aborted", clearIdleTimeout);
          response.once("error", clearIdleTimeout);
          response.once("close", clearIdleTimeout);
          const transport = observationForSocket(
            responseSocket,
            connectionReused,
            collectObservations,
            tlsSocketObservation,
          );
          resolve({
            response,
            ...(transport === undefined ? {} : { transport }),
            timings: phaseTimings(
              connectionReused ? undefined : dnsMs,
              connectionReused || !collectObservations
                ? undefined
                : (tlsSocketObservation?.connectMs ?? connectMs),
              connectionReused || !collectObservations
                ? undefined
                : tlsSocketObservation?.tlsMs,
              firstByteMs,
            ),
          });
        },
      );
      onRequest(request);
      request.once("socket", (assignedSocket) => {
        socket = assignedSocket;
        connectionReused = request.reusedSocket;
        /** Starts the response deadline after the usable connection exists. */
        const connected = (): void => {
          if (connectedAt !== undefined) return;
          connectedAt = performance.now();
          connectMs = connectedAt - connectStartedAt;
          clearTimeout(connectTimer);
          responseHeaderTimer = setTimeout(() => {
            request.destroy(
              new TargetTransportError({
                message: "The target did not send response headers in time.",
                causeCode: "APINTERACT_RESPONSE_HEADER_TIMEOUT",
                transport: observationForSocket(
                  assignedSocket,
                  connectionReused,
                  collectObservations,
                  https ? httpsAgent.observation(assignedSocket) : undefined,
                ),
                timings: phaseTimings(
                  connectionReused ? undefined : dnsMs,
                  connectionReused || !collectObservations
                    ? undefined
                    : connectMs,
                  connectionReused || !collectObservations
                    ? undefined
                    : httpsAgent.observation(assignedSocket)?.tlsMs,
                ),
              }),
            );
          }, target.behavior.responseHeaderTimeoutMs);
          responseHeaderTimer.unref();
        };
        if (assignedSocket.connecting) {
          assignedSocket.once(https ? "secureConnect" : "connect", connected);
        } else {
          connected();
        }
      });
      request.once("error", (cause) => {
        clearTimeout(connectTimer);
        if (responseHeaderTimer !== undefined) {
          clearTimeout(responseHeaderTimer);
        }
        if (cause instanceof TargetTransportError) {
          reject(cause);
          return;
        }
        const observed = observedTlsError(cause);
        reject(
          new TargetTransportError({
            message: "The target transport failed.",
            ...(observed?.causeCode === undefined &&
            errorCode(cause) === undefined
              ? {}
              : { causeCode: observed?.causeCode ?? errorCode(cause) }),
            transport: collectObservations
              ? (observed?.transport ??
                observationForSocket(
                  socket,
                  connectionReused,
                  true,
                  https ? httpsAgent.observation(socket) : undefined,
                ))
              : undefined,
            timings:
              observed === undefined
                ? phaseTimings(
                    connectionReused ? undefined : dnsMs,
                    connectionReused || !collectObservations
                      ? undefined
                      : connectMs,
                    connectionReused || !collectObservations
                      ? undefined
                      : httpsAgent.observation(socket)?.tlsMs,
                  )
                : collectObservations
                  ? {
                      ...(connectionReused || dnsMs === undefined
                        ? {}
                        : { dnsMs }),
                      ...observed.timings,
                    }
                  : {},
          }),
        );
      });
      request.end(requestBody);
    });
  }

  /** Destroys pooled sockets during proxy shutdown. */
  close(): void {
    this.#httpAgent.destroy();
    this.#strictHttpsAgent.destroy();
    this.#insecureHttpsAgent.destroy();
  }
}

/** HTTPS agent that completes observation and strict checks before assignment. */
class ObservedHttpsAgent extends HttpsAgent {
  readonly #verificationMode: "strict" | "insecure";
  readonly #observations = new WeakMap<Socket, SocketTlsObservation>();

  constructor(verificationMode: "strict" | "insecure") {
    super({ keepAlive: true });
    this.#verificationMode = verificationMode;
  }

  /** Returns immutable TLS facts associated with a newly established socket. */
  observation(socket: Socket | undefined): SocketTlsObservation | undefined {
    return socket === undefined ? undefined : this.#observations.get(socket);
  }

  /** Establishes and authorizes one TLS socket before releasing it to HTTP. */
  override createConnection(
    options: HttpsRequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (callback === undefined) {
      throw new Error("Observed HTTPS connections require an agent callback");
    }
    const startedAt = performance.now();
    let connectedAt: number | undefined;
    let finished = false;
    const connectionOptions = options as ConnectionOptions;
    const socket = tlsConnect({
      ...connectionOptions,
      rejectUnauthorized: false,
    });
    socket.once("connect", () => {
      connectedAt = performance.now();
    });
    socket.once("secureConnect", () => {
      if (finished) return;
      finished = true;
      const completedAt = performance.now();
      const trustError = tlsTrustError(socket, connectionOptions.servername);
      const tls = tlsObservation(
        socket,
        this.#verificationMode,
        trustError,
        connectionOptions.servername,
      );
      const observation = {
        tls,
        connectMs: (connectedAt ?? completedAt) - startedAt,
        tlsMs: completedAt - (connectedAt ?? startedAt),
      };
      this.#observations.set(socket, observation);
      if (this.#verificationMode === "strict" && trustError !== undefined) {
        const error = new ObservedTlsHandshakeError(
          trustError.runtimeCode,
          observationForSocket(socket, false, true, observation),
          phaseTimings(undefined, observation.connectMs, observation.tlsMs),
        );
        callback(error, socket);
        setImmediate(() => socket.destroy());
        return;
      }
      callback(null, socket);
    });
    socket.once("error", (cause) => {
      if (finished) return;
      finished = true;
      const failedAt = performance.now();
      const observation = tlsObservation(
        socket,
        this.#verificationMode,
        undefined,
        connectionOptions.servername,
      );
      callback(
        new ObservedTlsHandshakeError(
          errorCode(cause),
          observationForSocket(
            socket,
            false,
            true,
            observation.peerCertificateChain === undefined
              ? undefined
              : {
                  tls: observation,
                  connectMs: (connectedAt ?? failedAt) - startedAt,
                  tlsMs: failedAt - (connectedAt ?? startedAt),
                },
          ),
          phaseTimings(
            undefined,
            connectedAt === undefined ? undefined : connectedAt - startedAt,
            connectedAt === undefined ? undefined : failedAt - connectedAt,
          ),
        ),
        socket,
      );
    });
    return undefined;
  }
}

/** TLS establishment error carrying only safe structured observations. */
class ObservedTlsHandshakeError extends Error {
  readonly causeCode: string | undefined;
  readonly transport: TransportObservation | undefined;
  readonly timings: Omit<ExecutionTimings, "totalMs">;

  constructor(
    causeCode: string | undefined,
    transport: TransportObservation | undefined,
    timings: Omit<ExecutionTimings, "totalMs">,
  ) {
    super("The target TLS handshake failed.");
    this.causeCode = causeCode;
    this.transport = transport;
    this.timings = timings;
  }
}

/** Reads the safe observed TLS failure fields from an arbitrary request error. */
function observedTlsError(
  cause: unknown,
): ObservedTlsHandshakeError | undefined {
  if (cause instanceof ObservedTlsHandshakeError) return cause;
  const nested = (cause as { readonly cause?: unknown } | undefined)?.cause;
  return nested instanceof ObservedTlsHandshakeError ? nested : undefined;
}

/** Produces one best-effort observation from a connected socket. */
function observationForSocket(
  socket: Socket | undefined,
  connectionReused: boolean,
  enabled: boolean,
  tls?: SocketTlsObservation,
): TransportObservation | undefined {
  if (!enabled) return undefined;
  const localEndpoint = socketEndpoint(
    socket?.localAddress,
    socket?.localPort,
    socket?.localFamily,
  );
  const remoteEndpoint = socketEndpoint(
    socket?.remoteAddress,
    socket?.remotePort,
    socket?.remoteFamily,
  );
  const observation: TransportObservation = {
    connectionReused,
    ...(localEndpoint === undefined ? {} : { localEndpoint }),
    ...(remoteEndpoint === undefined ? {} : { remoteEndpoint }),
    ...(tls === undefined ? {} : { tls: tls.tls }),
  };
  return observation;
}

/** Normalizes Node socket endpoint fields onto the public address-family enum. */
function socketEndpoint(
  address: string | undefined,
  port: number | undefined,
  family: string | undefined,
): components["schemas"]["NetworkEndpoint"] | undefined {
  if (address === undefined || port === undefined) return undefined;
  if (family === "IPv4") return { address, port, family: "ipv4" };
  if (family === "IPv6") return { address, port, family: "ipv6" };
  return undefined;
}

/** Builds phase timings without inserting unavailable phases. */
function phaseTimings(
  dnsMs?: number,
  connectMs?: number,
  tlsMs?: number,
  firstByteMs?: number,
): Omit<ExecutionTimings, "totalMs"> {
  return {
    ...(dnsMs === undefined ? {} : { dnsMs }),
    ...(connectMs === undefined ? {} : { connectMs }),
    ...(tlsMs === undefined ? {} : { tlsMs }),
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
  };
}

interface TlsTrustError {
  readonly code: TlsAuthorizationErrorCode;
  readonly runtimeCode?: string;
}

/** Evaluates the runtime chain result and then the requested server hostname. */
function tlsTrustError(
  socket: TLSSocket,
  serverName: string | undefined,
): TlsTrustError | undefined {
  if (!socket.authorized) {
    const authorizationError = socket.authorizationError;
    const runtimeCode = errorCode(authorizationError);
    return {
      code: normalizeTlsAuthorizationError(runtimeCode),
      ...(runtimeCode === undefined ? {} : { runtimeCode }),
    };
  }
  const certificate = socket.getPeerCertificate(true);
  if (serverName !== undefined && certificate.raw !== undefined) {
    const hostnameError = checkServerIdentity(serverName, certificate);
    if (hostnameError !== undefined) {
      const runtimeCode = errorCode(hostnameError);
      return {
        code: "hostname_mismatch",
        ...(runtimeCode === undefined ? {} : { runtimeCode }),
      };
    }
  }
  return undefined;
}

/** Captures negotiated TLS facts and bounded exact peer certificate bytes. */
function tlsObservation(
  socket: TLSSocket,
  verificationMode: "strict" | "insecure",
  trustError: TlsTrustError | undefined,
  configuredServerName: string | undefined,
): TlsObservation {
  const chain = peerCertificateChain(socket.getPeerCertificate(true));
  const protocol = socket.getProtocol();
  // Node's declaration omits the null result produced before cipher
  // negotiation on some failed handshakes.
  const cipher = socket.getCipher() as ReturnType<
    TLSSocket["getCipher"]
  > | null;
  return {
    verificationMode,
    ...(socket.authorized || trustError !== undefined
      ? { authorized: trustError === undefined }
      : {}),
    ...(trustError === undefined
      ? {}
      : { authorizationErrorCode: trustError.code }),
    ...(protocol === "TLSv1.2" || protocol === "TLSv1.3" ? { protocol } : {}),
    alpnProtocol: socket.alpnProtocol === "http/1.1" ? "http/1.1" : null,
    serverName: configuredServerName ?? null,
    ...(cipher === null || cipher.name.length === 0
      ? {}
      : {
          cipher: {
            name: cipher.name,
            standardName: cipher.standardName ?? null,
          },
        }),
    ...(chain.certificates.length === 0
      ? {}
      : { peerCertificateChain: chain.certificates }),
    ...(chain.observedCount === 0
      ? {}
      : {
          peerCertificateChainCaptureComplete: chain.omittedCount === 0,
          omittedPeerCertificateCount: chain.omittedCount,
        }),
  };
}

/** Traverses Node's detailed leaf-first chain and applies fixed safety limits. */
function peerCertificateChain(certificate: DetailedPeerCertificate): {
  readonly certificates: components["schemas"]["TlsPeerCertificate"][];
  readonly observedCount: number;
  readonly omittedCount: number;
} {
  const observed: Buffer[] = [];
  const fingerprints = new Set<string>();
  let current: DetailedPeerCertificate | undefined = certificate;
  while (current?.raw !== undefined) {
    const fingerprint = createHash("sha256").update(current.raw).digest("hex");
    if (fingerprints.has(fingerprint)) break;
    fingerprints.add(fingerprint);
    observed.push(current.raw);
    const issuer: DetailedPeerCertificate | undefined =
      current.issuerCertificate;
    current = issuer === current ? undefined : issuer;
  }

  const certificates: components["schemas"]["TlsPeerCertificate"][] = [];
  let retainedBytes = 0;
  for (const raw of observed) {
    if (
      certificates.length >= MAX_PEER_CERTIFICATES ||
      retainedBytes + raw.byteLength > MAX_PEER_CERTIFICATE_DER_BYTES
    ) {
      break;
    }
    retainedBytes += raw.byteLength;
    certificates.push({
      derBase64: raw.toString("base64"),
      sha256Fingerprint: createHash("sha256").update(raw).digest("hex"),
    });
  }
  return {
    certificates,
    observedCount: observed.length,
    omittedCount: observed.length - certificates.length,
  };
}

/** Maps runtime verification codes onto stable public failure categories. */
function normalizeTlsAuthorizationError(
  code: string | undefined,
): TlsAuthorizationErrorCode {
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return "self_signed_certificate";
  if (
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_GET_ISSUER_CERT" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "CERT_UNTRUSTED"
  ) {
    return "unknown_certificate_authority";
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "hostname_mismatch";
  if (code === "CERT_HAS_EXPIRED") return "certificate_expired";
  if (code === "CERT_NOT_YET_VALID") return "certificate_not_yet_valid";
  if (code === "CERT_REVOKED") return "certificate_revoked";
  if (
    code === "INVALID_CA" ||
    code === "CERT_SIGNATURE_FAILURE" ||
    code === "CERT_CHAIN_TOO_LONG" ||
    code === "PATH_LENGTH_EXCEEDED"
  ) {
    return "invalid_certificate_chain";
  }
  if (code === "UNSUPPORTED_CERTIFICATE_PURPOSE") {
    return "unsupported_certificate";
  }
  return "other_verification_error";
}

/** Extracts a runtime error code without retaining its potentially unsafe text. */
function errorCode(cause: unknown): string | undefined {
  return typeof (cause as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (cause as NodeJS.ErrnoException).code
    : undefined;
}
