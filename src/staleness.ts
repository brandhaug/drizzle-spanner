import { SpannerInvalidArgumentError } from './errors.js';

/**
 * Timestamp bound for read-only transactions and single-use stale reads.
 * Exactly one bound applies. Durations take milliseconds or a `'15s'` /
 * `'500ms'` string; timestamps take a `Date` or an ISO-8601 string.
 */
export type SpannerStaleness =
  | { strong: true }
  | { exactStaleness: number | string }
  | { maxStaleness: number | string }
  | { readTimestamp: Date | string }
  | { minReadTimestamp: Date | string };

/** protobuf `Timestamp` — the only timestamp form the driver passes through unmangled. */
export interface SpannerProtoTimestamp {
  seconds: number;
  nanos: number;
}

/** The driver's `TimestampBounds` in the forms this adapter emits. */
export interface SpannerTimestampBounds {
  strong?: boolean;
  /** Milliseconds — the driver's numeric convenience form. */
  exactStaleness?: number;
  /** Milliseconds; Spanner accepts this bound on single-use reads only. */
  maxStaleness?: number;
  readTimestamp?: SpannerProtoTimestamp;
  minReadTimestamp?: SpannerProtoTimestamp;
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s)$/;

function durationToMs(value: number | string, bound: string): number {
  if (typeof value === 'number') return value;
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new SpannerInvalidArgumentError({
      message: `Invalid ${bound} duration "${value}": use milliseconds or a string like '15s' or '500ms'`,
    });
  }
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}

function toProtoTimestamp(value: Date | string, bound: string): SpannerProtoTimestamp {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new SpannerInvalidArgumentError({
      message: `Invalid ${bound} timestamp "${String(value)}": use a Date or an ISO-8601 string`,
    });
  }
  const seconds = Math.floor(ms / 1000);
  return { seconds, nanos: (ms - seconds * 1000) * 1_000_000 };
}

/**
 * Encodes a staleness bound into the driver's `TimestampBounds`. Timestamps
 * become protobuf `{ seconds, nanos }` because the driver only recognizes its
 * own `PreciseDate` — a plain `Date` would fall through as a protobuf value.
 */
export function toTimestampBounds(staleness: SpannerStaleness): SpannerTimestampBounds {
  if ('strong' in staleness) return { strong: true };
  if ('exactStaleness' in staleness) {
    return { exactStaleness: durationToMs(staleness.exactStaleness, 'exactStaleness') };
  }
  if ('maxStaleness' in staleness) {
    return { maxStaleness: durationToMs(staleness.maxStaleness, 'maxStaleness') };
  }
  if ('readTimestamp' in staleness) {
    return { readTimestamp: toProtoTimestamp(staleness.readTimestamp, 'readTimestamp') };
  }
  return { minReadTimestamp: toProtoTimestamp(staleness.minReadTimestamp, 'minReadTimestamp') };
}
