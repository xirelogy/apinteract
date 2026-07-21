import type { FastifyReply } from "fastify";

import { createEntityId } from "../foundation/id.js";

export interface ProblemOptions {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly errors?: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}

/** Sends an RFC 9457 problem response with a fresh correlation identifier. */
export function sendProblem(
  reply: FastifyReply,
  options: ProblemOptions,
): FastifyReply {
  return reply
    .code(options.status)
    .type("application/problem+json")
    .send({
      type: `/problems/${options.code}`,
      title: options.title,
      status: options.status,
      code: options.code,
      detail: options.detail,
      correlationId: createEntityId(),
      errors: options.errors ?? [],
    });
}
