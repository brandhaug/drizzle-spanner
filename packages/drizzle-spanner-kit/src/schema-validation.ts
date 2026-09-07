import { type KeyPart, type SpannerEntity } from './snapshot.js'

function invalid(path: string, message: string): never {
  throw new TypeError(`drizzle-spanner-kit: ${path} ${message}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

export function snapshotString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(path, 'must be a non-empty string')
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return invalid(path, 'must be a boolean')
  }
  return value
}

function list(value: unknown, path: string): Array<unknown> {
  if (!Array.isArray(value)) {
    return invalid(path, 'must be an array')
  }
  return value
}

export function snapshotStrings(value: unknown, path: string): Array<string> {
  return list(value, path).map((item, i) => snapshotString(item, `${path}[${i}]`))
}

function onDelete(value: unknown, path: string): 'cascade' | 'noAction' {
  if (value !== 'cascade' && value !== 'noAction') {
    return invalid(path, 'must be cascade or noAction')
  }
  return value
}

function keyParts(value: unknown, path: string): Array<KeyPart> {
  return list(value, path).map((item, i) => {
    const partPath = `${path}[${i}]`
    const part = object(item, partPath)
    const name = snapshotString(part.name, `${partPath}.name`)
    if (part.order !== 'asc' && part.order !== 'desc') {
      return invalid(`${partPath}.order`, 'must be asc or desc')
    }
    return { name, order: part.order }
  })
}

function parseEntity(value: unknown, path: string): SpannerEntity {
  const entity = object(value, path)
  const entityType = entity.entityType
  switch (entityType) {
    case 'tables': {
      const name = snapshotString(entity.name, `${path}.name`)
      if (entity.interleave === null) {
        return { entityType, name, interleave: null }
      }
      const interleave = object(entity.interleave, `${path}.interleave`)
      return {
        entityType,
        name,
        interleave: {
          parent: snapshotString(interleave.parent, `${path}.interleave.parent`),
          onDelete: onDelete(interleave.onDelete, `${path}.interleave.onDelete`)
        }
      }
    }
    case 'columns': {
      const generated =
        entity.generated === null ? null : object(entity.generated, `${path}.generated`)
      return {
        entityType,
        table: snapshotString(entity.table, `${path}.table`),
        name: snapshotString(entity.name, `${path}.name`),
        type: snapshotString(entity.type, `${path}.type`),
        notNull: boolean(entity.notNull, `${path}.notNull`),
        default:
          entity.default === null
            ? null
            : snapshotString(entity.default, `${path}.default`),
        generated: generated && {
          as: snapshotString(generated.as, `${path}.generated.as`),
          stored: boolean(generated.stored, `${path}.generated.stored`)
        },
        generatedIdentity: boolean(
          entity.generatedIdentity,
          `${path}.generatedIdentity`
        ),
        allowCommitTimestamp: boolean(
          entity.allowCommitTimestamp,
          `${path}.allowCommitTimestamp`
        )
      }
    }
    case 'pks': {
      return {
        entityType,
        table: snapshotString(entity.table, `${path}.table`),
        columns: keyParts(entity.columns, `${path}.columns`)
      }
    }
    case 'indexes': {
      return {
        entityType,
        table: snapshotString(entity.table, `${path}.table`),
        name: snapshotString(entity.name, `${path}.name`),
        columns: keyParts(entity.columns, `${path}.columns`),
        unique: boolean(entity.unique, `${path}.unique`),
        nullFiltered: boolean(entity.nullFiltered, `${path}.nullFiltered`),
        storing: snapshotStrings(entity.storing, `${path}.storing`)
      }
    }
    case 'fks': {
      return {
        entityType,
        table: snapshotString(entity.table, `${path}.table`),
        name: snapshotString(entity.name, `${path}.name`),
        columns: snapshotStrings(entity.columns, `${path}.columns`),
        foreignTable: snapshotString(entity.foreignTable, `${path}.foreignTable`),
        foreignColumns: snapshotStrings(
          entity.foreignColumns,
          `${path}.foreignColumns`
        ),
        onDelete: onDelete(entity.onDelete, `${path}.onDelete`)
      }
    }
    case 'checks': {
      return {
        entityType,
        table: snapshotString(entity.table, `${path}.table`),
        name: snapshotString(entity.name, `${path}.name`),
        value: snapshotString(entity.value, `${path}.value`)
      }
    }
    case 'sequences': {
      if (entity.kind !== 'bit_reversed_positive') {
        return invalid(`${path}.kind`, 'must be bit_reversed_positive')
      }
      return {
        entityType,
        name: snapshotString(entity.name, `${path}.name`),
        kind: entity.kind
      }
    }
    default: {
      return invalid(
        `${path}.entityType`,
        `contains an unknown entity type ${String(entityType)}`
      )
    }
  }
}

/** Checks the references and identities shared by disk, schema exports and introspection. */
function validateReferences(entities: Array<SpannerEntity>, source: string): void {
  const tables = new Map(
    entities
      .filter((entity) => entity.entityType === 'tables')
      .map((table) => [table.name, table])
  )
  const columns = new Map<string, Set<string>>()
  const primaryKeys = new Set<string>()
  const identities = new Set<string>()
  for (const entity of entities) {
    const owner = 'table' in entity ? entity.table : ''
    const name = 'name' in entity ? entity.name : ''
    // Index and sequence names are global; constraints share a table-scoped namespace.
    const kind =
      entity.entityType === 'fks' || entity.entityType === 'checks'
        ? 'constraints'
        : entity.entityType
    const identity = JSON.stringify([
      kind,
      entity.entityType === 'indexes' ? '' : owner,
      name
    ])
    if (identities.has(identity)) {
      invalid(
        source,
        `contains duplicate ${kind} entry ${owner ? `${owner}.` : ''}${name}`
      )
    }
    identities.add(identity)
    if ('table' in entity && !tables.has(entity.table)) {
      invalid(source, `${entity.entityType} references missing table "${entity.table}"`)
    }
    if (entity.entityType === 'columns') {
      const names = columns.get(entity.table) ?? new Set<string>()
      names.add(entity.name)
      columns.set(entity.table, names)
    }
    if (entity.entityType === 'pks') {
      primaryKeys.add(entity.table)
    }
  }
  const checkColumns = (
    table: string,
    names: Array<string>,
    path: string,
    allowEmpty = false
  ): void => {
    if (!tables.has(table)) {
      invalid(path, `references missing table "${table}"`)
    }
    if (!allowEmpty && names.length === 0) {
      invalid(path, 'must name at least one column')
    }
    if (new Set(names).size !== names.length) {
      invalid(path, 'contains duplicate columns')
    }
    for (const name of names) {
      if (!columns.get(table)?.has(name)) {
        invalid(path, `references missing column "${table}.${name}"`)
      }
    }
  }
  for (const entity of entities) {
    switch (entity.entityType) {
      case 'tables': {
        if (!primaryKeys.has(entity.name)) {
          invalid(source, `table "${entity.name}" has no primary key`)
        }
        if (!columns.has(entity.name)) {
          invalid(source, `table "${entity.name}" has no columns`)
        }
        const visited = new Set<string>([entity.name])
        let parent = entity.interleave?.parent
        while (parent !== undefined) {
          if (visited.has(parent)) {
            invalid(source, `contains an interleave cycle at "${parent}"`)
          }
          visited.add(parent)
          const parentTable = tables.get(parent)
          if (!parentTable) {
            invalid(source, `interleave references missing table "${parent}"`)
          }
          parent = parentTable.interleave?.parent
        }
        break
      }
      case 'pks':
      case 'indexes': {
        checkColumns(
          entity.table,
          entity.columns.map((part) => part.name),
          `${source} ${entity.entityType} on "${entity.table}"`
        )
        if (entity.entityType === 'indexes') {
          checkColumns(
            entity.table,
            entity.storing,
            `${source} index "${entity.name}" storing`,
            true
          )
        }
        break
      }
      case 'fks': {
        const path = `${source} foreign key "${entity.name}"`
        checkColumns(entity.table, entity.columns, path)
        checkColumns(entity.foreignTable, entity.foreignColumns, path)
        if (entity.columns.length !== entity.foreignColumns.length) {
          invalid(path, 'must have matching local and foreign column counts')
        }
        break
      }
      case 'checks':
      case 'columns':
      case 'sequences': {
        break
      }
    }
  }
}

/** Reconstructs trusted entities from untrusted input without changing declaration order. */
export function validateSchemaEntities(
  value: unknown,
  source: string
): Array<SpannerEntity> {
  const entities = list(value, `${source}.ddl`).map((entity, i) =>
    parseEntity(entity, `${source}.ddl[${i}]`)
  )
  validateReferences(entities, source)
  return entities
}

export { object as snapshotObject }
