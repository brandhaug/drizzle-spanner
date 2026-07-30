import type { KitDriverDatabase } from './connect.js';
import type {
  ColumnEntity,
  ForeignKeyEntity,
  IndexEntity,
  KeyPart,
  SpannerEntity,
} from './snapshot.js';

const BOOKKEEPING_TABLE = '__drizzle_migrations';

type Row = Record<string, unknown>;

async function query(database: KitDriverDatabase, sql: string): Promise<Row[]> {
  const [rows] = await database.run({ sql, json: true } as never);
  return rows as Row[];
}

function text(row: Row, column: string): string {
  return String(row[column]);
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
}

function yes(row: Row, column: string): boolean {
  const value = row[column];
  return value === true || value === 'YES' || value === 'TRUE';
}

function toOnDelete(rule: string | null): 'cascade' | 'noAction' {
  return rule === 'CASCADE' ? 'cascade' : 'noAction';
}

/**
 * Reads the database's schema from INFORMATION_SCHEMA into snapshot entities
 * (spec: introspection — tables, columns, interleaving via PARENT_TABLE_NAME,
 * indexes, sequences, foreign keys, check constraints). The migrations
 * bookkeeping table is excluded.
 */
export async function introspectDatabase(database: KitDriverDatabase): Promise<SpannerEntity[]> {
  const [tables, columns, columnOptions, indexes, indexColumns, constraints, keyUsage, referential, checks, sequences] =
    await Promise.all([
      query(
        database,
        "SELECT TABLE_NAME, PARENT_TABLE_NAME, ON_DELETE_ACTION FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      ),
      query(
        database,
        "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE, SPANNER_TYPE, GENERATION_EXPRESSION, IS_STORED, IS_IDENTITY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '' ORDER BY TABLE_NAME, ORDINAL_POSITION",
      ),
      query(
        database,
        "SELECT TABLE_NAME, COLUMN_NAME, OPTION_NAME, OPTION_VALUE FROM INFORMATION_SCHEMA.COLUMN_OPTIONS WHERE TABLE_SCHEMA = ''",
      ),
      query(
        database,
        "SELECT TABLE_NAME, INDEX_NAME, INDEX_TYPE, IS_UNIQUE, IS_NULL_FILTERED FROM INFORMATION_SCHEMA.INDEXES WHERE TABLE_SCHEMA = '' AND SPANNER_IS_MANAGED = FALSE",
      ),
      query(
        database,
        "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_ORDERING FROM INFORMATION_SCHEMA.INDEX_COLUMNS WHERE TABLE_SCHEMA = '' ORDER BY TABLE_NAME, INDEX_NAME, ORDINAL_POSITION",
      ),
      query(
        database,
        "SELECT CONSTRAINT_NAME, TABLE_NAME, CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ''",
      ),
      query(
        database,
        "SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, POSITION_IN_UNIQUE_CONSTRAINT FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = '' ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
      ),
      query(
        database,
        "SELECT CONSTRAINT_NAME, UNIQUE_CONSTRAINT_NAME, DELETE_RULE FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ''",
      ),
      query(
        database,
        "SELECT tc.TABLE_NAME AS TABLE_NAME, cc.CONSTRAINT_NAME AS CONSTRAINT_NAME, cc.CHECK_CLAUSE AS CHECK_CLAUSE FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA WHERE cc.CONSTRAINT_SCHEMA = '' AND cc.CONSTRAINT_NAME NOT LIKE 'CK_IS_NOT_NULL%'",
      ),
      query(database, "SELECT NAME FROM INFORMATION_SCHEMA.SEQUENCES WHERE SCHEMA = ''"),
    ]);

  const entities: SpannerEntity[] = [];
  const tableNames = new Set(
    tables.map((row) => text(row, 'TABLE_NAME')).filter((name) => name !== BOOKKEEPING_TABLE),
  );

  for (const row of sequences) {
    entities.push({
      entityType: 'sequences',
      name: text(row, 'NAME'),
      kind: 'bit_reversed_positive',
    });
  }

  const commitTimestampColumns = new Set(
    columnOptions
      .filter(
        (row) =>
          text(row, 'OPTION_NAME') === 'allow_commit_timestamp' &&
          text(row, 'OPTION_VALUE').toUpperCase() === 'TRUE',
      )
      .map((row) => `${text(row, 'TABLE_NAME')}.${text(row, 'COLUMN_NAME')}`),
  );

  for (const tableRow of tables) {
    const tableName = text(tableRow, 'TABLE_NAME');
    if (!tableNames.has(tableName)) continue;
    const parent = optionalText(tableRow, 'PARENT_TABLE_NAME');
    entities.push({
      entityType: 'tables',
      name: tableName,
      interleave: parent
        ? { parent, onDelete: toOnDelete(optionalText(tableRow, 'ON_DELETE_ACTION')) }
        : null,
    });

    for (const columnRow of columns) {
      if (text(columnRow, 'TABLE_NAME') !== tableName) continue;
      const columnName = text(columnRow, 'COLUMN_NAME');
      const generationExpression = optionalText(columnRow, 'GENERATION_EXPRESSION');
      const entity: ColumnEntity = {
        entityType: 'columns',
        table: tableName,
        name: columnName,
        type: text(columnRow, 'SPANNER_TYPE'),
        notNull: !yes(columnRow, 'IS_NULLABLE'),
        default: optionalText(columnRow, 'COLUMN_DEFAULT'),
        generated: generationExpression
          ? { as: generationExpression, stored: yes(columnRow, 'IS_STORED') }
          : null,
        generatedIdentity: yes(columnRow, 'IS_IDENTITY'),
        allowCommitTimestamp: commitTimestampColumns.has(`${tableName}.${columnName}`),
      };
      entities.push(entity);
    }

    const keyPartsOf = (indexName: string): KeyPart[] =>
      indexColumns
        .filter(
          (row) =>
            text(row, 'TABLE_NAME') === tableName &&
            text(row, 'INDEX_NAME') === indexName &&
            row['ORDINAL_POSITION'] !== null,
        )
        .map((row) => ({
          name: text(row, 'COLUMN_NAME'),
          order: optionalText(row, 'COLUMN_ORDERING') === 'DESC' ? 'desc' : 'asc',
        }));

    entities.push({
      entityType: 'pks',
      table: tableName,
      columns: keyPartsOf('PRIMARY_KEY'),
    });

    for (const indexRow of indexes) {
      if (
        text(indexRow, 'TABLE_NAME') !== tableName ||
        text(indexRow, 'INDEX_TYPE') === 'PRIMARY_KEY'
      ) {
        continue;
      }
      const indexName = text(indexRow, 'INDEX_NAME');
      const entity: IndexEntity = {
        entityType: 'indexes',
        table: tableName,
        name: indexName,
        columns: keyPartsOf(indexName),
        unique: yes(indexRow, 'IS_UNIQUE'),
        nullFiltered: yes(indexRow, 'IS_NULL_FILTERED'),
        storing: indexColumns
          .filter(
            (row) =>
              text(row, 'TABLE_NAME') === tableName &&
              text(row, 'INDEX_NAME') === indexName &&
              row['ORDINAL_POSITION'] === null,
          )
          .map((row) => text(row, 'COLUMN_NAME')),
      };
      entities.push(entity);
    }

    for (const constraintRow of constraints) {
      if (
        text(constraintRow, 'TABLE_NAME') !== tableName ||
        text(constraintRow, 'CONSTRAINT_TYPE') !== 'FOREIGN KEY'
      ) {
        continue;
      }
      const constraintName = text(constraintRow, 'CONSTRAINT_NAME');
      const fkUsage = keyUsage.filter((row) => text(row, 'CONSTRAINT_NAME') === constraintName);
      const referentialRow = referential.find(
        (row) => text(row, 'CONSTRAINT_NAME') === constraintName,
      );
      if (!referentialRow || fkUsage.length === 0) continue;
      const uniqueName = text(referentialRow, 'UNIQUE_CONSTRAINT_NAME');
      const uniqueUsage = keyUsage.filter((row) => text(row, 'CONSTRAINT_NAME') === uniqueName);
      const foreignTable = uniqueUsage[0] ? text(uniqueUsage[0], 'TABLE_NAME') : tableName;
      const entity: ForeignKeyEntity = {
        entityType: 'fks',
        table: tableName,
        name: constraintName,
        columns: fkUsage.map((row) => text(row, 'COLUMN_NAME')),
        foreignTable,
        foreignColumns: fkUsage.map((row) => {
          const position = Number(row['POSITION_IN_UNIQUE_CONSTRAINT']);
          const match = uniqueUsage.find((unique) => Number(unique['ORDINAL_POSITION']) === position);
          return match ? text(match, 'COLUMN_NAME') : '';
        }),
        onDelete: toOnDelete(optionalText(referentialRow, 'DELETE_RULE')),
      };
      entities.push(entity);
    }

    for (const checkRow of checks) {
      if (text(checkRow, 'TABLE_NAME') !== tableName) continue;
      entities.push({
        entityType: 'checks',
        table: tableName,
        name: text(checkRow, 'CONSTRAINT_NAME'),
        value: text(checkRow, 'CHECK_CLAUSE'),
      });
    }
  }

  return entities;
}
