import { describe, expect, it } from 'bun:test'
import { Param, sql } from 'drizzle-orm/sql'
import { Subquery } from 'drizzle-orm/subquery'
import { SpannerDialect, int64, spannerTable, string } from '../../src/index.js'

const table = spannerTable('items', {
  id: int64('id').primaryKey(),
  name: string('name', { length: 'max' })
})
const dialect = new SpannerDialect()
const id = () => new Param(7, table.id)
const name = () => new Param('x', table.name)

describe('SQL parameter metadata compilation', () => {
  it('collects nested wrapper and subquery parameters in emission order', () => {
    let calls = 0
    const wrapper = {
      getSQL: () => {
        calls++
        return sql`${id()}`
      }
    }
    const query = dialect.sqlToQuery(
      sql`${wrapper}, ${new Subquery(sql`select ${id()}`, {}, 'nested', false)}, ${name()}`
    )
    expect(query.sql).toBe('(@p0), (select @p1) `nested`, @p2')
    expect(query.params).toEqual([7, 7, 'x'])
    expect(query.typings).toEqual(['int64', 'int64', 'string'])
    expect(query.paramColumns).toEqual(['id', 'id', 'name'])
    expect(calls).toBe(1)
  })

  it('does not allocate metadata for inlined parameters', () => {
    const query = dialect.sqlToQuery(sql`${sql`${id()}`.inlineParams()}, ${name()}`)
    expect(query.sql).toBe('7, @p0')
    expect(query.params).toEqual(['x'])
    expect(query.typings).toEqual(['string'])
    expect(query.paramColumns).toEqual(['name'])
    const inline = dialect.sqlToQuery(sql`${id()}, ${name()}`.inlineParams())
    expect(inline.sql).toBe("7, 'x'")
    expect(inline.params).toEqual([])
    expect(inline.typings).toEqual([])
    expect(inline.paramColumns).toEqual([])
  })

  it('uses parameters produced by encoders instead of the original parameter', () => {
    let calls = 0
    const expanded = new Param('unused', {
      mapToDriverValue: () => {
        calls++
        return sql`coalesce(${name()}, ${id()})`
      }
    })
    const query = dialect.sqlToQuery(
      sql`${expanded}, ${new Param(sql`${id()}`)}, ${name()}`
    )
    expect(query.sql).toBe('coalesce(@p0, @p1), @p2, @p3')
    expect(query.params).toEqual(['x', 7, 7, 'x'])
    expect(query.typings).toEqual(['string', 'int64', 'int64', 'string'])
    expect(query.paramColumns).toEqual(['name', 'id', 'id', 'name'])
    expect(calls).toBe(1)
  })

  it('keeps raw objects, arrays, and placeholders aligned with typed parameters', () => {
    const object = { value: 1 }
    const placeholder = sql.placeholder('id')
    const typedPlaceholder = new Param(sql.placeholder('name'), table.name)
    const query = dialect.sqlToQuery(
      sql`${object}, ${[id(), object]}, ${placeholder}, ${typedPlaceholder}, ${name()}`
    )
    expect(query.sql).toBe('@p0, (@p1, @p2), @p3, @p4, @p5')
    expect(query.params).toEqual([
      object,
      7,
      object,
      placeholder,
      typedPlaceholder,
      'x'
    ])
    expect(query.typings).toEqual(['none', 'int64', 'none', 'none', 'string', 'string'])
    expect(query.paramColumns).toEqual([
      undefined,
      'id',
      undefined,
      undefined,
      'name',
      'name'
    ])
  })

  it('does not mutate or retain metadata between compilations of the same SQL', () => {
    const input = sql`${id()}, ${name()}`
    const first = dialect.sqlToQuery(input)
    expect(dialect.sqlToQuery(input)).toEqual(first)
    expect(dialect.sqlToQuery(input.inlineParams()).params).toEqual([])
    expect(first.typings).toEqual(['int64', 'string'])
  })
})
