import { entityKind } from 'drizzle-orm/entity';
import { DrizzleError } from 'drizzle-orm/errors';

/**
 * Query context attached to every SpannerError. Carries parameter names,
 * never parameter values (spec: error-handling section).
 */
export interface SpannerErrorQueryContext {
  sql: string;
  paramNames: string[];
}

export interface SpannerErrorOptions {
  message: string;
  /** gRPC status code, when the failure came from the driver. */
  code?: number;
  cause?: unknown;
  query?: SpannerErrorQueryContext;
}

/** Base class of the typed Spanner failure taxonomy. Match variants with `kind`. */
export abstract class SpannerError extends DrizzleError {
  static readonly [entityKind]: string = 'SpannerError';

  abstract readonly kind:
    | 'aborted'
    | 'constraint'
    | 'invalid-argument'
    | 'precision'
    | 'ddl'
    | 'unavailable';

  readonly code: number | undefined;
  readonly query: SpannerErrorQueryContext | undefined;

  constructor(options: SpannerErrorOptions) {
    super({ message: options.message, cause: options.cause });
    this.code = options.code;
    this.query = options.query;
  }
}

/** Read-write transaction aborted and the driver's retries are exhausted. */
export class SpannerAbortedError extends SpannerError {
  static override readonly [entityKind]: string = 'SpannerAbortedError';
  override readonly kind = 'aborted';
}

/** Unique index, foreign key, and check violations. */
export class SpannerConstraintError extends SpannerError {
  static override readonly [entityKind]: string = 'SpannerConstraintError';
  override readonly kind = 'constraint';
}

/** INVALID_ARGUMENT, including the untyped-parameter case with a column hint. */
export class SpannerInvalidArgumentError extends SpannerError {
  static override readonly [entityKind]: string = 'SpannerInvalidArgumentError';
  override readonly kind = 'invalid-argument';
}

/** INT64 decode past 2^53−1 in `number` mode. Use `int64(name, { mode: 'bigint' })`. */
export class SpannerPrecisionError extends SpannerError {
  static override readonly [entityKind]: string = 'SpannerPrecisionError';
  override readonly kind = 'precision';
}

/** Failed or partially applied `updateSchema` operations. */
export class SpannerDdlError extends SpannerError {
  static override readonly [entityKind]: string = 'SpannerDdlError';
  override readonly kind = 'ddl';
}

/** Transport and deadline failures. */
export class SpannerUnavailableError extends SpannerError {
  static override readonly [entityKind]: string = 'SpannerUnavailableError';
  override readonly kind = 'unavailable';
}

/** gRPC status codes the taxonomy dispatches on. */
export const GrpcStatus = {
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNAVAILABLE: 14,
} as const;

const CONSTRAINT_MESSAGE = /unique|foreign key|check constraint|already exists|parent row|constraint/i;

/**
 * Wraps a driver/gRPC error into the typed taxonomy. Errors that carry no
 * gRPC code (programming errors, rollbacks) pass through unchanged.
 */
export function wrapSpannerError(error: unknown, query?: SpannerErrorQueryContext): unknown {
  if (error instanceof SpannerError) return error;
  const grpcError = error as { code?: unknown; message?: unknown };
  if (typeof grpcError?.code !== 'number') return error;
  const message = typeof grpcError.message === 'string' ? grpcError.message : 'Spanner error';
  const options: SpannerErrorOptions = { message, code: grpcError.code, cause: error, query };

  switch (grpcError.code) {
    case GrpcStatus.ABORTED:
      return new SpannerAbortedError(options);
    case GrpcStatus.ALREADY_EXISTS:
      return new SpannerConstraintError(options);
    case GrpcStatus.FAILED_PRECONDITION:
      return CONSTRAINT_MESSAGE.test(message)
        ? new SpannerConstraintError(options)
        : new SpannerInvalidArgumentError(options);
    case GrpcStatus.INVALID_ARGUMENT:
      return new SpannerInvalidArgumentError({
        ...options,
        message: /parameter/i.test(message)
          ? `${message} (hint: a null or empty-array parameter needs a type hint; drizzle-spanner derives hints from schema columns, so make sure the value is bound through a table column)`
          : message,
      });
    case GrpcStatus.UNAVAILABLE:
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new SpannerUnavailableError(options);
    default:
      return error;
  }
}
