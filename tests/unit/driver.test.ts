import { type Database } from '@google-cloud/spanner'
import { describe, expect, it } from 'bun:test'
import { drizzle, spannerTable, string } from '../../src/index.js'

const singers = spannerTable('singers', {
  id: string('id', { length: 36 }).primaryKey(),
  name: string('name', { length: 'max' })
})

describe('drizzle()', () => {
  it("takes the driver's Database as the README shows", async () => {
    // A stand-in typed as the driver's class: the drizzle() call is the contract under test.
    const database = {
      run: async () => [
        [
          [
            { name: 'id', value: 's1' },
            { name: 'name', value: 'Ada' }
          ]
        ]
      ]
    } as unknown as Database

    const rows = await drizzle(database).select().from(singers)

    expect(rows).toEqual([{ id: 's1', name: 'Ada' }])
  })
})
