import { isDeepStrictEqual } from 'node:util'
import { type SpannerEntity } from './snapshot.js'

function entityKey(entity: SpannerEntity): string {
  return JSON.stringify([
    entity.entityType,
    'table' in entity ? entity.table : null,
    'name' in entity ? entity.name : null
  ])
}

function normalize(entity: SpannerEntity | undefined): SpannerEntity | undefined {
  return entity?.entityType === 'indexes'
    ? { ...entity, storing: entity.storing.toSorted() }
    : entity
}

/** Compare schema meaning while ignoring entity order and STORING column order. */
export function assertSchemaRoundtrip(
  introspected: Array<SpannerEntity>,
  generated: Array<SpannerEntity>
): void {
  const actual = new Map(generated.map((entity) => [entityKey(entity), entity]))
  for (const expected of introspected) {
    const key = entityKey(expected)
    const received = actual.get(key)
    if (!isDeepStrictEqual(normalize(expected), normalize(received))) {
      throw new Error(
        `drizzle-spanner-kit: generated schema does not preserve introspected entity ${key}; refusing to publish a pull baseline`
      )
    }
    actual.delete(key)
  }
  if (actual.size > 0) {
    throw new Error(
      `drizzle-spanner-kit: generated schema contains entities absent from introspection; refusing to publish a pull baseline`
    )
  }
}
