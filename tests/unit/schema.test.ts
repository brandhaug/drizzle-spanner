import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm/table';
import { getTableColumns } from 'drizzle-orm/utils';
import { int64, spannerTable, string } from '../../src/index.js';
import { SpannerPrecisionError } from '../../src/index.js';

describe('spannerTable', () => {
  it('builds a table with named columns', () => {
    const singers = spannerTable('singers', {
      id: string('id', { length: 36 }).primaryKey(),
      name: string('name', { length: 'max' }).notNull(),
    });

    expect(getTableName(singers)).toBe('singers');
    const columns = getTableColumns(singers);
    expect(Object.keys(columns)).toEqual(['id', 'name']);
    expect(singers.id.name).toBe('id');
    expect(singers.id.primary).toBe(true);
    expect(singers.name.notNull).toBe(true);
  });
});

describe('string', () => {
  it('renders STRING(n) and STRING(MAX)', () => {
    const t = spannerTable('t', {
      a: string('a', { length: 36 }),
      b: string('b', { length: 'max' }),
    });
    expect(t.a.getSQLType()).toBe('STRING(36)');
    expect(t.b.getSQLType()).toBe('STRING(MAX)');
  });

  it('defaultGenerateUuid marks the column as having a default', () => {
    const t = spannerTable('t', {
      id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
    });
    expect(t.id.hasDefault).toBe(true);
  });
});

describe('int64', () => {
  it('renders INT64', () => {
    const t = spannerTable('t', { n: int64('n') });
    expect(t.n.getSQLType()).toBe('INT64');
  });

  it('number mode decodes the driver Int wrapper to number', () => {
    const t = spannerTable('t', { n: int64('n') });
    expect(t.n.mapFromDriverValue({ value: '42' })).toBe(42);
    expect(t.n.mapFromDriverValue(null)).toBeNull();
  });

  it('number mode throws SpannerPrecisionError past 2^53-1', () => {
    const t = spannerTable('t', { n: int64('n') });
    expect(() => t.n.mapFromDriverValue({ value: '9007199254740993' })).toThrow(
      SpannerPrecisionError,
    );
  });

  it('bigint mode decodes to bigint across the full INT64 range', () => {
    const t = spannerTable('t', { n: int64('n', { mode: 'bigint' }) });
    expect(t.n.mapFromDriverValue({ value: '9223372036854775807' })).toBe(9223372036854775807n);
  });

  it('bigint mode encodes bigint as a string for the driver', () => {
    const t = spannerTable('t', { n: int64('n', { mode: 'bigint' }) });
    expect(t.n.mapToDriverValue(9223372036854775807n)).toBe('9223372036854775807');
  });
});

describe('remaining column types', () => {
  it('renders the Spanner DDL type for every column', async () => {
    const { float64, float32, numeric, bytes, bool, date, timestamp, json } = await import(
      '../../src/index.js'
    );
    const t = spannerTable('t', {
      f64: float64('f64'),
      f32: float32('f32'),
      num: numeric('num'),
      bin: bytes('bin', { length: 'max' }),
      bin2: bytes('bin2', { length: 1024 }),
      flag: bool('flag'),
      day: date('day'),
      at: timestamp('at'),
      doc: json('doc'),
      tags: string('tags', { length: 'max' }).array(),
    });
    expect(t.f64.getSQLType()).toBe('FLOAT64');
    expect(t.f32.getSQLType()).toBe('FLOAT32');
    expect(t.num.getSQLType()).toBe('NUMERIC');
    expect(t.bin.getSQLType()).toBe('BYTES(MAX)');
    expect(t.bin2.getSQLType()).toBe('BYTES(1024)');
    expect(t.flag.getSQLType()).toBe('BOOL');
    expect(t.day.getSQLType()).toBe('DATE');
    expect(t.at.getSQLType()).toBe('TIMESTAMP');
    expect(t.doc.getSQLType()).toBe('JSON');
    expect(t.tags.getSQLType()).toBe('ARRAY<STRING(MAX)>');
  });

  it('float64 unwraps driver Float wrappers', async () => {
    const { float64 } = await import('../../src/index.js');
    const t = spannerTable('t', { x: float64('x') });
    expect(t.x.mapFromDriverValue({ value: 1.5 })).toBe(1.5);
    expect(t.x.mapFromDriverValue(2.5)).toBe(2.5);
  });

  it('numeric decodes the driver Numeric wrapper to a string by default', async () => {
    const { numeric } = await import('../../src/index.js');
    const t = spannerTable('t', { x: numeric('x') });
    expect(t.x.mapFromDriverValue({ value: '3.141592653' })).toBe('3.141592653');
  });

  it('numeric number mode decodes to number', async () => {
    const { numeric } = await import('../../src/index.js');
    const t = spannerTable('t', { x: numeric('x', { mode: 'number' }) });
    expect(t.x.mapFromDriverValue({ value: '3.5' })).toBe(3.5);
  });

  it('date decodes to a YYYY-MM-DD string by default and Date in date mode', async () => {
    const { date } = await import('../../src/index.js');
    const t = spannerTable('t', {
      s: date('s'),
      d: date('d', { mode: 'date' }),
    });
    expect(t.s.mapFromDriverValue(new Date('2026-07-29T00:00:00Z'))).toBe('2026-07-29');
    expect(t.d.mapFromDriverValue(new Date('2026-07-29T00:00:00Z'))).toEqual(
      new Date('2026-07-29T00:00:00Z'),
    );
  });

  it('timestamp decodes PreciseDate to a plain Date', async () => {
    const { timestamp } = await import('../../src/index.js');
    const t = spannerTable('t', { at: timestamp('at') });
    const decoded = t.at.mapFromDriverValue(new Date('2026-07-29T10:00:00Z'));
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe('2026-07-29T10:00:00.000Z');
  });

  it('timestamp records the allowCommitTimestamp DDL option', async () => {
    const { timestamp } = await import('../../src/index.js');
    const t = spannerTable('t', {
      at: timestamp('at', { allowCommitTimestamp: true }),
      plain: timestamp('plain'),
    });
    expect((t.at as unknown as { allowCommitTimestamp: boolean }).allowCommitTimestamp).toBe(true);
    expect((t.plain as unknown as { allowCommitTimestamp: boolean }).allowCommitTimestamp).toBe(
      false,
    );
  });

  it('array maps element values through the base column', async () => {
    const { int64 } = await import('../../src/index.js');
    const t = spannerTable('t', { ns: int64('ns').array() });
    expect(t.ns.mapFromDriverValue([{ value: '1' }, { value: '2' }, null])).toEqual([1, 2, null]);
  });
});

describe('extra config builders', () => {
  it('index captures nullFiltered, storing and key order', async () => {
    const { index } = await import('../../src/index.js');
    const t = spannerTable('t', {
      a: string('a', { length: 36 }).primaryKey(),
      b: string('b', { length: 'max' }),
      c: string('c', { length: 'max' }),
    });
    const builders: any[] = [];
    spannerTable(
      't2',
      {
        a: string('a', { length: 36 }).primaryKey(),
        b: string('b', { length: 'max' }),
        c: string('c', { length: 'max' }),
      },
      (cols) => {
        const b = index('idx_b').on(cols.b.desc()).nullFiltered().storing(t.c);
        builders.push(b);
        return [b];
      },
    );
    const config = builders[0].config;
    expect(config.name).toBe('idx_b');
    expect(config.nullFiltered).toBe(true);
    expect(config.columns[0].order).toBe('desc');
    expect(config.storing).toHaveLength(1);
  });

  it('interleaveInParent validates the PK prefix at definition time', async () => {
    const { primaryKey, interleaveInParent } = await import('../../src/index.js');
    const singers = spannerTable('singers', {
      id: string('id', { length: 36 }).primaryKey(),
    });
    // Valid: child PK starts with the parent PK.
    const albums = spannerTable(
      'albums',
      {
        id: string('id', { length: 36 }).notNull(),
        albumId: string('album_id', { length: 36 }).notNull(),
      },
      (t2) => [
        primaryKey({ columns: [t2.id, t2.albumId] }),
        interleaveInParent(singers, { onDelete: 'cascade' }),
      ],
    );
    expect(albums).toBeDefined();

    // Invalid: child PK does not start with the parent PK.
    expect(() =>
      spannerTable(
        'broken',
        {
          id: string('id', { length: 36 }).notNull(),
          other: string('other', { length: 36 }).notNull(),
        },
        (t2) => [
          primaryKey({ columns: [t2.other, t2.id] }),
          interleaveInParent(singers) as any,
        ],
      ),
    ).toThrow(/must start with the primary key/);
  });
});
