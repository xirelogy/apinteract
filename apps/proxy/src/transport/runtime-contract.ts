import type { FastifyInstance, FastifySchema } from "fastify";
import { proxyRuntimeContract } from "./proxy-runtime.generated.js";

const SCHEMA_PREFIX = "proxy://schemas/";

type JsonObject = Record<string, unknown>;

/** Registers canonical OpenAPI component schemas with Fastify's runtime validator. */
export function registerProxyRuntimeSchemas(server: FastifyInstance): void {
  for (const [name, source] of Object.entries(proxyRuntimeContract.schemas)) {
    server.addSchema({
      ...(rewriteReferences(source) as JsonObject),
      $id: schemaId(name),
    });
  }
}

/** Runtime schema for the authenticated execution-creation trust boundary. */
export const createExecutionRouteSchema: FastifySchema = {
  headers: {
    type: "object",
    required: ["idempotency-key"],
    properties: {
      "idempotency-key": parameterSchema("IdempotencyKey"),
    },
  },
  body: { $ref: schemaId("CreateExecutionRequest") },
};

/** Runtime schema for routes containing an opaque execution identifier. */
export const executionRouteSchema: FastifySchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["executionId"],
    properties: {
      executionId: parameterSchema("ExecutionId"),
    },
  },
};

/** Runtime schema for opening a sequence-based response-frame stream. */
export const responseStreamRouteSchema: FastifySchema = {
  ...executionRouteSchema,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      afterSequence: parameterSchema("AfterSequence"),
    },
  },
};

/** Rewrites document-local component references to registered Fastify schema IDs. */
function rewriteReferences(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteReferences);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const rewritten: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    // OpenAPI extensions describe custom enforcement performed by the
    // application layer and are not JSON Schema keywords understood by Ajv.
    if (key.startsWith("x-")) {
      continue;
    }
    rewritten[key] =
      key === "$ref" &&
      typeof member === "string" &&
      member.startsWith("#/components/schemas/")
        ? schemaId(member.slice("#/components/schemas/".length))
        : rewriteReferences(member);
  }
  return rewritten;
}

/** Returns one parameter's canonical schema without its OpenAPI location envelope. */
function parameterSchema(
  name: keyof typeof proxyRuntimeContract.parameters,
): JsonObject {
  return rewriteReferences(
    proxyRuntimeContract.parameters[name].schema,
  ) as JsonObject;
}

/** Produces the stable registry identifier for one OpenAPI component schema. */
function schemaId(name: string): string {
  return `${SCHEMA_PREFIX}${name}`;
}
