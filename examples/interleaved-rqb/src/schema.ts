import { defineRelations } from 'drizzle-orm/relations'
import {
  index,
  interleaveInParent,
  primaryKey,
  spannerTable,
  string
} from 'drizzle-spanner'
// Loaded dynamically by drizzle-spanner-kit (see drizzle-spanner.config.ts).
// fallow-ignore-file unused-file

// Spanner's interleave prefix rule matches by column NAME: the child's
// primary key must start with the parent's key columns under the same
// names, so the parent key is singer_id (not id) in both tables.
// fallow-ignore-next-line unused-export
export const singers = spannerTable('singers', {
  singerId: string('singer_id', { length: 36 }).primaryKey().defaultGenerateUuid(),
  name: string('name', { length: 'max' }).notNull()
})

// Interleaving is physical layout: albums rows are stored inside their
// singer's key range, so parent+children reads never leave one split.
// fallow-ignore-next-line unused-export
export const albums = spannerTable(
  'albums',
  {
    singerId: string('singer_id', { length: 36 }).notNull(),
    albumId: string('album_id', { length: 36 }).notNull(),
    title: string('title', { length: 1024 })
  },
  (t) => [
    primaryKey({ columns: [t.singerId, t.albumId] }),
    interleaveInParent(singers, { onDelete: 'cascade' }),
    index('idx_albums_title').on(t.title).nullFiltered()
  ]
)

// Relations are query semantics, declared separately — the adapter derives
// nothing from interleaveInParent.
// fallow-ignore-next-line unused-export
export const relations = defineRelations({ singers, albums }, (r) => ({
  singers: {
    albums: r.many.albums()
  },
  albums: {
    singer: r.one.singers({
      from: r.albums.singerId,
      to: r.singers.singerId
    })
  }
}))
