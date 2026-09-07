import {
  type CheckEntity,
  type ColumnEntity,
  type ForeignKeyEntity,
  type IndexEntity,
  type KeyPart,
  type PrimaryKeyEntity,
  type SpannerEntity,
  type TableEntity
} from './snapshot.js'
import { bucketEntities, groupByTable } from './entities.js'

/** Extra-config callbacks run during table construction, so every reference must exist. */
function orderSchemaTables(
  tables: Array<TableEntity>,
  fksByTable: Map<string, Array<ForeignKeyEntity>>
): Array<TableEntity> {
  const remaining = new Map(tables.map((table) => [table.name, table]))
  const ordered: Array<TableEntity> = []
  const visiting = new Set<string>()
  const visit = (table: TableEntity): void => {
    if (visiting.has(table.name)) {
      throw new Error(
        `drizzle-spanner-kit: cannot emit cyclic table references involving "${table.name}"`
      )
    }
    if (!remaining.has(table.name)) {
      return
    }
    visiting.add(table.name)
    const dependencies = [
      ...(table.interleave ? [table.interleave.parent] : []),
      ...(fksByTable.get(table.name) ?? []).map((fk) => fk.foreignTable)
    ]
    for (const name of dependencies) {
      const dependency = remaining.get(name)
      if (dependency) {
        visit(dependency)
      }
    }
    visiting.delete(table.name)
    remaining.delete(table.name)
    ordered.push(table)
  }
  for (const table of tables) {
    visit(table)
  }
  return ordered
}

/** `full_name` -> `fullName`; leading digits get a `t` prefix. */
function camelCase(name: string): string {
  const camel = name.replaceAll(/[_-]+(\w)/g, (_, char: string) => char.toUpperCase())
  return /^\d/.test(camel) ? `t${camel}` : camel
}

function lengthLiteral(length: string): string {
  return length === 'MAX' ? "'max'" : length
}

interface ParsedType {
  builder: string
  args: Array<string>
  array: boolean
}

function parseType(
  type: string,
  allowCommitTimestamp: boolean,
  name: string
): ParsedType {
  const arrayMatch = /^ARRAY<(.+)>$/.exec(type)
  const scalar = arrayMatch ? arrayMatch[1]! : type
  const array = arrayMatch !== null
  const nameArg = JSON.stringify(name)
  const sized = /^(STRING|BYTES)\((\d+|MAX)\)$/.exec(scalar)
  if (sized) {
    const builder = sized[1] === 'STRING' ? 'string' : 'bytes'
    return {
      builder,
      args: [nameArg, `{ length: ${lengthLiteral(sized[2]!)} }`],
      array
    }
  }
  const byName: Record<string, string> = {
    INT64: 'int64',
    FLOAT64: 'float64',
    FLOAT32: 'float32',
    NUMERIC: 'numeric',
    BOOL: 'bool',
    DATE: 'date',
    JSON: 'json',
    TOKENLIST: 'tokenlist'
  }
  if (scalar === 'TIMESTAMP') {
    return {
      builder: 'timestamp',
      args: allowCommitTimestamp
        ? [nameArg, '{ allowCommitTimestamp: true }']
        : [nameArg],
      array
    }
  }
  const builder = byName[scalar]
  if (!builder) {
    throw new Error(
      `drizzle-spanner-kit: cannot render column "${name}" of type ${type}`
    )
  }
  return { builder, args: [nameArg], array }
}

function renderColumn(column: ColumnEntity, inlinePrimaryKey: boolean): string {
  const parsed = parseType(column.type, column.allowCommitTimestamp, column.name)
  let expression = `${parsed.builder}(${parsed.args.join(', ')})`
  if (parsed.array) {
    expression += '.array()'
  }
  if (column.notNull) {
    expression += '.notNull()'
  }
  if (column.generatedIdentity) {
    expression += '.generatedAsIdentity()'
  } else if (column.generated) {
    expression += `.generatedAlwaysAs(sql.raw(${JSON.stringify(column.generated.as)}), { mode: '${column.generated.stored ? 'stored' : 'virtual'}' })`
  } else if (column.default !== null) {
    expression +=
      column.default === 'GENERATE_UUID()'
        ? '.defaultGenerateUuid()'
        : `.default(sql.raw(${JSON.stringify(column.default)}))`
  }
  if (inlinePrimaryKey) {
    expression += '.primaryKey()'
  }
  return `${camelCase(column.name)}: ${expression},`
}

function keyPartRef(part: KeyPart): string {
  return `t.${camelCase(part.name)}${part.order === 'desc' ? '.desc()' : ''}`
}

function renderExtraConfig(
  pk: PrimaryKeyEntity | undefined,
  inlinePk: boolean,
  table: TableEntity,
  tableVariables: Map<string, string>,
  indexes: Array<IndexEntity>,
  fks: Array<ForeignKeyEntity>,
  checks: Array<CheckEntity>
): { lines: Array<string>; imports: Set<string>; needsSql: boolean } {
  const lines: Array<string> = []
  const imports = new Set<string>()
  let needsSql = false

  if (pk && !inlinePk) {
    imports.add('primaryKey')
    lines.push(`primaryKey({ columns: [${pk.columns.map(keyPartRef).join(', ')}] }),`)
  }
  if (table.interleave) {
    imports.add('interleaveInParent')
    const parentVariable =
      tableVariables.get(table.interleave.parent) ?? table.interleave.parent
    lines.push(
      table.interleave.onDelete === 'cascade'
        ? `interleaveInParent(${parentVariable}, { onDelete: 'cascade' }),`
        : `interleaveInParent(${parentVariable}),`
    )
  }
  for (const index of indexes) {
    imports.add(index.unique ? 'uniqueIndex' : 'index')
    let line = `${index.unique ? 'uniqueIndex' : 'index'}(${JSON.stringify(index.name)}).on(${index.columns
      .map(keyPartRef)
      .join(', ')})`
    if (index.nullFiltered) {
      line += '.nullFiltered()'
    }
    if (index.storing.length > 0) {
      line += `.storing(${index.storing.map((name) => `t.${camelCase(name)}`).join(', ')})`
    }
    lines.push(`${line},`)
  }
  for (const fk of fks) {
    imports.add('foreignKey')
    const foreignVariable = tableVariables.get(fk.foreignTable) ?? fk.foreignTable
    const foreignColumns = fk.foreignColumns
      .map((name) => `${foreignVariable}.${camelCase(name)}`)
      .join(', ')
    let line =
      'foreignKey({\n' +
      `      name: ${JSON.stringify(fk.name)},\n` +
      `      columns: [${fk.columns.map((name) => `t.${camelCase(name)}`).join(', ')}],\n` +
      `      foreignColumns: [${foreignColumns}],\n` +
      '    })'
    if (fk.onDelete === 'cascade') {
      line += ".onDelete('cascade')"
    }
    lines.push(`${line},`)
  }
  for (const check of checks) {
    imports.add('check')
    needsSql = true
    lines.push(
      `check(${JSON.stringify(check.name)}, sql.raw(${JSON.stringify(check.value)})),`
    )
  }
  return { lines, imports, needsSql }
}

/**
 * Renders snapshot entities as a schema module in the milestone-1 schema
 * API — the output of `pull`.
 */
export function renderSchemaModule(entities: Array<SpannerEntity>): string {
  const buckets = bucketEntities(entities)
  const { tables, sequences } = buckets
  const columnsByTable = groupByTable(buckets.columns)
  const pks = new Map(buckets.pks.map((pk) => [pk.table, pk]))
  const indexesByTable = groupByTable(buckets.indexes)
  const fksByTable = groupByTable(buckets.fks)
  const checksByTable = groupByTable(buckets.checks)

  const tableVariables = new Map(
    tables.map((table) => [table.name, camelCase(table.name)])
  )

  // Parents (interleave and FK targets) must be declared before their
  // dependents reference them.
  const ordered = orderSchemaTables(tables, fksByTable)

  const imports = new Set<string>(['spannerTable'])
  let needsSql = false
  const declarations: Array<string> = []

  for (const sequence of sequences) {
    imports.add('sequence')
    declarations.push(
      `export const ${camelCase(sequence.name)} = sequence(${JSON.stringify(sequence.name)});`
    )
  }

  for (const table of ordered) {
    const columns = columnsByTable.get(table.name) ?? []
    const pk = pks.get(table.name)
    const indexes = indexesByTable.get(table.name) ?? []
    const fks = fksByTable.get(table.name) ?? []
    const checks = checksByTable.get(table.name) ?? []
    const inlinePk =
      pk?.columns.length === 1 &&
      pk.columns[0]!.order === 'asc' &&
      columns.some((column) => column.name === pk.columns[0]!.name && column.notNull)
    const inlinePkColumn = inlinePk ? pk.columns[0]!.name : undefined

    for (const column of columns) {
      const parsed = parseType(column.type, column.allowCommitTimestamp, column.name)
      imports.add(parsed.builder)
      if (
        column.generated ||
        (column.default !== null && column.default !== 'GENERATE_UUID()')
      ) {
        needsSql = true
      }
    }

    const columnLines = columns.map((column) =>
      renderColumn(column, column.name === inlinePkColumn)
    )
    const extra = renderExtraConfig(
      pk,
      inlinePk,
      table,
      tableVariables,
      indexes,
      fks,
      checks
    )
    for (const name of extra.imports) {
      imports.add(name)
    }
    needsSql ||= extra.needsSql

    const variable = tableVariables.get(table.name)!
    if (extra.lines.length === 0) {
      declarations.push(
        `export const ${variable} = spannerTable(${JSON.stringify(table.name)}, {\n${columnLines
          .map((line) => `  ${line}`)
          .join('\n')}\n});`
      )
    } else {
      declarations.push(
        `export const ${variable} = spannerTable(\n` +
          `  ${JSON.stringify(table.name)},\n` +
          `  {\n${columnLines.map((line) => `    ${line}`).join('\n')}\n  },\n` +
          `  (t) => [\n${extra.lines.map((line) => `    ${line}`).join('\n')}\n  ],\n` +
          `);`
      )
    }
  }

  const importList = [...imports].toSorted()
  const header = `${
    needsSql ? "import { sql } from 'drizzle-orm/sql';\n" : ''
  }import {\n${importList
    .map((name) => `  ${name},`)
    .join('\n')}\n} from 'drizzle-spanner';\n`
  return `${header}\n${declarations.join('\n\n')}\n`
}
