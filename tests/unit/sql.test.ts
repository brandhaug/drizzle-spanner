import { describe, expect, it } from 'bun:test'
import { eq, gt } from 'drizzle-orm/sql/expressions'
import { sql } from 'drizzle-orm/sql'
import {
  commitTimestamp,
  drizzle,
  int64,
  sequence,
  spannerTable,
  string,
  timestamp
} from '../../src/index.js'

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull(),
  plays: int64('plays'),
  updatedAt: timestamp('updated_at', { allowCommitTimestamp: true })
})

const db = drizzle.mock()

describe('select SQL', () => {
  it('renders backtick identifiers and named @p parameters', () => {
    const query = db.select().from(singers).where(eq(singers.name, 'Ada')).toSQL()
    expect(query.sql).toBe(
      'select `singers`.`id`, `singers`.`name`, `singers`.`plays`, `singers`.`updated_at` from `singers` where `singers`.`name` = @p0'
    )
    expect(query.params).toEqual(['Ada'])
  })

  it('renders a custom field selection with sql aliases', () => {
    const query = db
      .select({
        id: singers.id,
        upper: sql<string>`upper(${singers.name})`.as('upper_name')
      })
      .from(singers)
      .toSQL()
    expect(query.sql).toBe(
      'select `singers`.`id`, upper(`singers`.`name`) as `upper_name` from `singers`'
    )
  })

  it('renders order by, limit and offset', () => {
    const query = db
      .select()
      .from(singers)
      .where(gt(singers.plays, 10))
      .orderBy(singers.name)
      .limit(5)
      .offset(2)
      .toSQL()
    expect(query.sql).toBe(
      'select `singers`.`id`, `singers`.`name`, `singers`.`plays`, `singers`.`updated_at` from `singers` where `singers`.`plays` > @p0 order by `singers`.`name` limit @p1 offset @p2'
    )
    expect(query.params).toEqual([10, 5, 2])
  })
})

describe('insert SQL', () => {
  it('renders values with DEFAULT for omitted columns and THEN RETURN for returning()', () => {
    const query = db
      .insert(singers)
      .values({ name: 'Ada', plays: 42 })
      .returning()
      .toSQL()
    expect(query.sql).toBe(
      'insert into `singers` (`id`, `name`, `plays`, `updated_at`) values (default, @p0, @p1, default) then return `singers`.`id`, `singers`.`name`, `singers`.`plays`, `singers`.`updated_at`'
    )
    expect(query.params).toEqual(['Ada', 42])
  })

  it('renders multi-row inserts', () => {
    const query = db
      .insert(singers)
      .values([{ name: 'Ada' }, { name: 'Grace' }])
      .toSQL()
    expect(query.sql).toBe(
      'insert into `singers` (`id`, `name`, `plays`, `updated_at`) values (default, @p0, default, default), (default, @p1, default, default)'
    )
    expect(query.params).toEqual(['Ada', 'Grace'])
  })

  it('renders sequence().nextValue() as GET_NEXT_SEQUENCE_VALUE', () => {
    const seq = sequence('singer_id_seq')
    const t = spannerTable('t', {
      id: int64('id', { mode: 'bigint' }).primaryKey(),
      name: string('name', { length: 'max' })
    })
    const query = db.insert(t).values({ id: seq.nextValue(), name: 'Ada' }).toSQL()
    expect(query.sql).toBe(
      'insert into `t` (`id`, `name`) values (GET_NEXT_SEQUENCE_VALUE(SEQUENCE `singer_id_seq`), @p0)'
    )
    expect(query.params).toEqual(['Ada'])
  })

  it('renders the commitTimestamp() sentinel as PENDING_COMMIT_TIMESTAMP()', () => {
    const query = db
      .insert(singers)
      .values({ name: 'Ada', updatedAt: commitTimestamp() })
      .toSQL()
    expect(query.sql).toBe(
      'insert into `singers` (`id`, `name`, `plays`, `updated_at`) values (default, @p0, default, PENDING_COMMIT_TIMESTAMP())'
    )
    expect(query.params).toEqual(['Ada'])
  })
})

describe('update SQL', () => {
  it('renders set with where and THEN RETURN', () => {
    const query = db
      .update(singers)
      .set({ plays: 43 })
      .where(eq(singers.id, 'abc'))
      .returning({ id: singers.id })
      .toSQL()
    expect(query.sql).toBe(
      'update `singers` set `plays` = @p0 where `singers`.`id` = @p1 then return `singers`.`id`'
    )
    expect(query.params).toEqual([43, 'abc'])
  })

  it('emits `where true` when no where clause is given (Spanner requires WHERE)', () => {
    const query = db.update(singers).set({ plays: 0 }).toSQL()
    expect(query.sql).toBe('update `singers` set `plays` = @p0 where true')
  })

  it('renders the commitTimestamp() sentinel in set()', () => {
    const query = db
      .update(singers)
      .set({ updatedAt: commitTimestamp() })
      .where(eq(singers.id, 'abc'))
      .toSQL()
    expect(query.sql).toBe(
      'update `singers` set `updated_at` = PENDING_COMMIT_TIMESTAMP() where `singers`.`id` = @p0'
    )
  })
})

describe('upsert SQL', () => {
  it('renders orUpdate() as INSERT OR UPDATE', () => {
    const query = db.insert(singers).values({ id: 'a', name: 'Ada' }).orUpdate().toSQL()
    expect(query.sql).toBe(
      'insert or update into `singers` (`id`, `name`, `plays`, `updated_at`) values (@p0, @p1, default, default)'
    )
    expect(query.params).toEqual(['a', 'Ada'])
  })

  it('renders orIgnore() as INSERT OR IGNORE', () => {
    const query = db.insert(singers).values({ id: 'a', name: 'Ada' }).orIgnore().toSQL()
    expect(query.sql).toBe(
      'insert or ignore into `singers` (`id`, `name`, `plays`, `updated_at`) values (@p0, @p1, default, default)'
    )
  })

  it('composes orUpdate() with returning() as THEN RETURN', () => {
    const query = db
      .insert(singers)
      .values({ id: 'a', name: 'Ada' })
      .orUpdate()
      .returning({ id: singers.id })
      .toSQL()
    expect(query.sql).toBe(
      'insert or update into `singers` (`id`, `name`, `plays`, `updated_at`) values (@p0, @p1, default, default) then return `singers`.`id`'
    )
  })

  it('rejects combining orUpdate() and orIgnore()', () => {
    expect(() =>
      db.insert(singers).values({ id: 'a', name: 'Ada' }).orUpdate().orIgnore()
    ).toThrow(/orUpdate|orIgnore/)
  })
})

describe('delete SQL', () => {
  it('renders delete with where', () => {
    const query = db.delete(singers).where(eq(singers.id, 'abc')).toSQL()
    expect(query.sql).toBe('delete from `singers` where `singers`.`id` = @p0')
    expect(query.params).toEqual(['abc'])
  })

  it('emits `where true` when no where clause is given', () => {
    const query = db.delete(singers).toSQL()
    expect(query.sql).toBe('delete from `singers` where true')
  })
})

describe('parameter type hints', () => {
  it('collects Spanner type hints from schema columns', async () => {
    const { SpannerDialect } = await import('../../src/index.js')
    const dialect = new SpannerDialect()
    const query = dialect.sqlToQuery(
      db
        .insert(singers)
        .values({ name: 'Ada', plays: null, updatedAt: new Date() })
        .getSQL()
    )
    // bun:test types toEqual<T> off the received value, so widen explicitly.
    expect(query.typings).toEqual<string[]>(['string', 'int64', 'timestamp'])
  })
})
