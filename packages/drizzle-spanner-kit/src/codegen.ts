import type {
  CheckEntity,
  ColumnEntity,
  ForeignKeyEntity,
  IndexEntity,
  PrimaryKeyEntity,
  SpannerEntity,
  TableEntity,
} from './snapshot.js';
import { bucketEntities, groupByTable } from './entities.js';

/** `full_name` -> `fullName`; leading digits get a `t` prefix. */
function camelCase(name: string): string {
  const camel = name.replace(/[_-]+(\w)/g, (_, char: string) => char.toUpperCase());
  return /^\d/.test(camel) ? `t${camel}` : camel;
}

function lengthLiteral(length: string): string {
  return length === 'MAX' ? "'max'" : length;
}

interface ParsedType {
  builder: string;
  args: string[];
  array: boolean;
}

function parseType(type: string, allowCommitTimestamp: boolean, name: string): ParsedType {
  const arrayMatch = /^ARRAY<(.+)>$/.exec(type);
  const scalar = arrayMatch ? arrayMatch[1]! : type;
  const array = arrayMatch !== null;
  const nameArg = `'${name}'`;
  const sized = /^(STRING|BYTES)\((\d+|MAX)\)$/.exec(scalar);
  if (sized) {
    const builder = sized[1] === 'STRING' ? 'string' : 'bytes';
    return { builder, args: [nameArg, `{ length: ${lengthLiteral(sized[2]!)} }`], array };
  }
  const byName: Record<string, string> = {
    INT64: 'int64',
    FLOAT64: 'float64',
    FLOAT32: 'float32',
    NUMERIC: 'numeric',
    BOOL: 'bool',
    DATE: 'date',
    JSON: 'json',
    TOKENLIST: 'tokenlist',
  };
  if (scalar === 'TIMESTAMP') {
    return {
      builder: 'timestamp',
      args: allowCommitTimestamp ? [nameArg, '{ allowCommitTimestamp: true }'] : [nameArg],
      array,
    };
  }
  const builder = byName[scalar];
  if (!builder) {
    throw new Error(`drizzle-spanner-kit: cannot render column "${name}" of type ${type}`);
  }
  return { builder, args: [nameArg], array };
}

function renderColumn(column: ColumnEntity, inlinePrimaryKey: boolean): string {
  const parsed = parseType(column.type, column.allowCommitTimestamp, column.name);
  let expression = `${parsed.builder}(${parsed.args.join(', ')})`;
  if (parsed.array) expression += '.array()';
  if (column.notNull) expression += '.notNull()';
  if (column.generatedIdentity) {
    expression += '.generatedAsIdentity()';
  } else if (column.generated) {
    expression += `.generatedAlwaysAs(sql\`${column.generated.as}\`)`;
  } else if (column.default !== null) {
    expression +=
      column.default === 'GENERATE_UUID()'
        ? '.defaultGenerateUuid()'
        : `.default(sql\`${column.default}\`)`;
  }
  if (inlinePrimaryKey) expression += '.primaryKey()';
  return `${camelCase(column.name)}: ${expression},`;
}

function keyPartRef(part: { name: string; order: 'asc' | 'desc' }): string {
  return `t.${camelCase(part.name)}${part.order === 'desc' ? '.desc()' : ''}`;
}

function renderExtraConfig(
  pk: PrimaryKeyEntity | undefined,
  inlinePk: boolean,
  table: TableEntity,
  tableVariables: Map<string, string>,
  indexes: IndexEntity[],
  fks: ForeignKeyEntity[],
  checks: CheckEntity[],
): { lines: string[]; imports: Set<string>; needsSql: boolean } {
  const lines: string[] = [];
  const imports = new Set<string>();
  let needsSql = false;

  if (pk && !inlinePk) {
    imports.add('primaryKey');
    lines.push(`primaryKey({ columns: [${pk.columns.map(keyPartRef).join(', ')}] }),`);
  }
  if (table.interleave) {
    imports.add('interleaveInParent');
    const parentVariable = tableVariables.get(table.interleave.parent) ?? table.interleave.parent;
    lines.push(
      table.interleave.onDelete === 'cascade'
        ? `interleaveInParent(${parentVariable}, { onDelete: 'cascade' }),`
        : `interleaveInParent(${parentVariable}),`,
    );
  }
  for (const index of indexes) {
    imports.add(index.unique ? 'uniqueIndex' : 'index');
    let line = `${index.unique ? 'uniqueIndex' : 'index'}('${index.name}').on(${index.columns
      .map(keyPartRef)
      .join(', ')})`;
    if (index.nullFiltered) line += '.nullFiltered()';
    if (index.storing.length > 0) {
      line += `.storing(${index.storing.map((name) => `t.${camelCase(name)}`).join(', ')})`;
    }
    lines.push(`${line},`);
  }
  for (const fk of fks) {
    imports.add('foreignKey');
    const foreignVariable = tableVariables.get(fk.foreignTable) ?? fk.foreignTable;
    const foreignColumns = fk.foreignColumns
      .map((name) => `${foreignVariable}.${camelCase(name)}`)
      .join(', ');
    let line =
      'foreignKey({\n' +
      `      name: '${fk.name}',\n` +
      `      columns: [${fk.columns.map((name) => `t.${camelCase(name)}`).join(', ')}],\n` +
      `      foreignColumns: [${foreignColumns}],\n` +
      '    })';
    if (fk.onDelete === 'cascade') line += ".onDelete('cascade')";
    lines.push(`${line},`);
  }
  for (const check of checks) {
    imports.add('check');
    needsSql = true;
    lines.push(`check('${check.name}', sql\`${check.value}\`),`);
  }
  return { lines, imports, needsSql };
}

/**
 * Renders snapshot entities as a schema module in the milestone-1 schema
 * API — the output of `pull`.
 */
export function renderSchemaModule(entities: SpannerEntity[]): string {
  const buckets = bucketEntities(entities);
  const { tables, sequences } = buckets;
  const columnsByTable = groupByTable(buckets.columns);
  const pks = new Map(buckets.pks.map((pk) => [pk.table, pk]));
  const indexesByTable = groupByTable(buckets.indexes);
  const fksByTable = groupByTable(buckets.fks);
  const checksByTable = groupByTable(buckets.checks);

  const tableVariables = new Map(tables.map((table) => [table.name, camelCase(table.name)]));

  // Parents (interleave and FK targets) must be declared before their
  // dependents reference them.
  const ordered: TableEntity[] = [];
  const remaining = new Map(tables.map((table) => [table.name, table]));
  const visit = (table: TableEntity): void => {
    if (!remaining.has(table.name)) return;
    remaining.delete(table.name);
    const dependencies = [
      ...(table.interleave ? [table.interleave.parent] : []),
      ...(fksByTable.get(table.name) ?? []).map((fk) => fk.foreignTable),
    ];
    for (const dependency of dependencies) {
      const parent = remaining.get(dependency);
      if (parent) visit(parent);
    }
    ordered.push(table);
  };
  for (const table of tables) visit(table);

  const imports = new Set<string>(['spannerTable']);
  let needsSql = false;
  const declarations: string[] = [];

  for (const sequence of sequences) {
    imports.add('sequence');
    declarations.push(`export const ${camelCase(sequence.name)} = sequence('${sequence.name}');`);
  }

  for (const table of ordered) {
    const columns = columnsByTable.get(table.name) ?? [];
    const pk = pks.get(table.name);
    const indexes = indexesByTable.get(table.name) ?? [];
    const fks = fksByTable.get(table.name) ?? [];
    const checks = checksByTable.get(table.name) ?? [];
    const inlinePk =
      pk !== undefined && pk.columns.length === 1 && pk.columns[0]!.order === 'asc';
    const inlinePkColumn = inlinePk ? pk.columns[0]!.name : undefined;

    for (const column of columns) {
      const parsed = parseType(column.type, column.allowCommitTimestamp, column.name);
      imports.add(parsed.builder);
      if (column.generated || (column.default !== null && column.default !== 'GENERATE_UUID()')) {
        needsSql = true;
      }
    }

    const columnLines = columns.map((column) =>
      renderColumn(column, column.name === inlinePkColumn),
    );
    const extra = renderExtraConfig(pk, inlinePk, table, tableVariables, indexes, fks, checks);
    for (const name of extra.imports) imports.add(name);
    needsSql ||= extra.needsSql;

    const variable = tableVariables.get(table.name)!;
    if (extra.lines.length === 0) {
      declarations.push(
        `export const ${variable} = spannerTable('${table.name}', {\n` +
          columnLines.map((line) => `  ${line}`).join('\n') +
          '\n});',
      );
    } else {
      declarations.push(
        `export const ${variable} = spannerTable(\n` +
          `  '${table.name}',\n` +
          '  {\n' +
          columnLines.map((line) => `    ${line}`).join('\n') +
          '\n  },\n' +
          '  (t) => [\n' +
          extra.lines.map((line) => `    ${line}`).join('\n') +
          '\n  ],\n' +
          ');',
      );
    }
  }

  const importList = [...imports].sort();
  const header =
    (needsSql ? "import { sql } from 'drizzle-orm/sql';\n" : '') +
    'import {\n' +
    importList.map((name) => `  ${name},`).join('\n') +
    "\n} from 'drizzle-spanner';\n";
  return `${header}\n${declarations.join('\n\n')}\n`;
}
