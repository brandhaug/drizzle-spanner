// Spike e2e: CRUD + read-write transaction against the Spanner emulator.
// Run: SPANNER_EMULATOR_HOST=localhost:9010 node spike/run.js
import { Spanner } from '@google-cloud/spanner';
import { eq, gt } from 'drizzle-orm/sql/expressions';
import { sql } from 'drizzle-orm/sql';
import { spannerTable } from './table.js';
import { string, int64, timestamp } from './columns.js';
import { drizzle } from './driver.js';

const PROJECT_ID = process.env.SPANNER_PROJECT_ID ?? 'test-project';
const INSTANCE_ID = process.env.SPANNER_INSTANCE_ID ?? 'test-instance';
const DATABASE_ID = process.env.SPANNER_DATABASE_ID ?? 'test-database';

if (!process.env.SPANNER_EMULATOR_HOST) {
	console.error('Set SPANNER_EMULATOR_HOST (for example localhost:9010).');
	process.exit(1);
}

// Draft schema API from issue #9 (subset).
const singers = spannerTable('singers', {
	id: string('id', { length: 36 }).primaryKey().defaultGenerateUuid(),
	name: string('name', { length: 'max' }).notNull(),
	plays: int64('plays'),
	updatedAt: timestamp('updated_at'),
});

function assert(condition, label) {
	if (!condition) throw new Error(`ASSERTION FAILED: ${label}`);
	console.log(`ok - ${label}`);
}

async function main() {
	const spanner = new Spanner({ projectId: PROJECT_ID });
	const database = spanner.instance(INSTANCE_ID).database(DATABASE_ID);

	// Hand-written DDL (drizzle-kit has no spanner dialect; see research doc).
	console.log('Creating table via updateSchema...');
	try {
		const [operation] = await database.updateSchema([
			`CREATE TABLE singers (
				id STRING(36) NOT NULL DEFAULT (GENERATE_UUID()),
				name STRING(MAX) NOT NULL,
				plays INT64,
				updated_at TIMESTAMP
			) PRIMARY KEY (id)`,
		]);
		await operation.promise();
		console.log('Table created.');
	} catch (e) {
		if (String(e.message).includes('Duplicate name')) {
			console.log('Table exists; clearing rows.');
			await database.runTransactionAsync(async (txn) => {
				await txn.runUpdate({ sql: 'DELETE FROM singers WHERE true' });
				await txn.commit();
			});
		} else {
			throw e;
		}
	}

	const db = drizzle(database, { logger: true });

	// 1. INSERT with .returning() (THEN RETURN), param binding, DEFAULT pk.
	const inserted = await db
		.insert(singers)
		.values({ name: 'Ada', plays: 42, updatedAt: new Date('2026-07-29T10:00:00Z') })
		.returning();
	console.log('inserted:', inserted);
	assert(inserted.length === 1, 'insert returned one row');
	assert(typeof inserted[0].id === 'string' && inserted[0].id.length === 36, 'THEN RETURN produced a generated UUID pk');
	assert(inserted[0].name === 'Ada', 'returned name matches');
	assert(inserted[0].plays === 42, 'returned int64 mapped to number');
	assert(inserted[0].updatedAt instanceof Date, 'returned timestamp mapped to Date');
	const adaId = inserted[0].id;

	// 2. SELECT with where (param binding on string and int64).
	const selected = await db.select().from(singers).where(eq(singers.name, 'Ada'));
	console.log('selected:', selected);
	assert(selected.length === 1, 'select-where found the row');
	assert(selected[0].id === adaId, 'select returned the same pk');

	const selectedByInt = await db.select().from(singers).where(gt(singers.plays, 40));
	assert(selectedByInt.length === 1, 'select with int64 param binding works');

	// 3. UPDATE with where + returning.
	const updated = await db
		.update(singers)
		.set({ plays: 43 })
		.where(eq(singers.id, adaId))
		.returning();
	console.log('updated:', updated);
	assert(updated.length === 1 && updated[0].plays === 43, 'update-where with THEN RETURN works');

	// 4. Read-write transaction: insert + read + update atomically.
	const txResult = await db.transaction(async (tx) => {
		const [grace] = await tx.insert(singers).values({ name: 'Grace', plays: 1 }).returning();
		const rowsInTx = await tx.select().from(singers);
		await tx.update(singers).set({ plays: 100 }).where(eq(singers.id, grace.id));
		return { graceId: grace.id, countInTx: rowsInTx.length };
	});
	console.log('transaction result:', txResult);
	assert(txResult.countInTx === 2, 'transaction read its own uncommitted insert');
	const graceAfter = await db.select().from(singers).where(eq(singers.id, txResult.graceId));
	assert(graceAfter.length === 1 && graceAfter[0].plays === 100, 'transaction committed atomically');

	// 5. DELETE with where.
	await db.delete(singers).where(eq(singers.id, adaId));
	const afterDelete = await db.select().from(singers);
	assert(afterDelete.length === 1 && afterDelete[0].name === 'Grace', 'delete-where removed exactly one row');

	// 6. Raw SQL escape hatch through the dialect.
	const rawCount = await db.execute(sql`select count(*) as c from ${singers}`);
	console.log('raw count:', rawCount);

	await database.close();
	spanner.close();
	console.log('\nSPIKE PASSED: CRUD round-trip and read-write transaction ran green against the emulator.');
}

main().catch((e) => {
	console.error('\nSPIKE FAILED:', e);
	process.exit(1);
});
