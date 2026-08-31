import { createRequire } from "node:module";

export type SqlOutputValue = string | number | bigint | Uint8Array | null;
export type SqlParameter = string | number | bigint | Uint8Array | null;
export type SqlRow = Readonly<Record<string, SqlOutputValue>>;

type SqlStatement = Readonly<{
	run: (...parameters: readonly SqlParameter[]) => Readonly<{ lastInsertRowid: number | bigint }>;
	get: (...parameters: readonly SqlParameter[]) => SqlRow | undefined;
	all: (...parameters: readonly SqlParameter[]) => readonly SqlRow[];
}>;

type RawSqlStatement = Readonly<{
	run: (...parameters: readonly SqlParameter[]) => Readonly<{ lastInsertRowid: number | bigint }>;
	get: (...parameters: readonly SqlParameter[]) => SqlRow | null | undefined;
	all: (...parameters: readonly SqlParameter[]) => readonly SqlRow[];
}>;

type RawSqlDatabase = Readonly<{
	exec: (sql: string) => void;
	prepare: (sql: string) => RawSqlStatement;
	close: () => void;
}>;

export type SqlDatabase = Readonly<{
	exec: (sql: string) => void;
	prepare: (sql: string) => SqlStatement;
	close: () => void;
}>;

type BunSqlite = Readonly<{
	Database: new (path: string, options?: Readonly<{ readonly?: boolean | undefined }>) => RawSqlDatabase;
}>;

type NodeSqlite = Readonly<{
	DatabaseSync: new (
		path: string,
		options: Readonly<{ timeout: number; readOnly?: boolean | undefined }>,
	) => RawSqlDatabase;
}>;

const require = createRequire(import.meta.url);

export type SqliteOpenOptions = Readonly<{ readOnly?: boolean | undefined }>;

export function openSqlite(path: string, options: SqliteOpenOptions = {}): SqlDatabase {
	const database = process.versions["bun"] === undefined ? openNodeSqlite(path, options) : openBunSqlite(path, options);
	return normalizeSqlite(database);
}

function openBunSqlite(path: string, options: SqliteOpenOptions): RawSqlDatabase {
	// SAFETY: Pi runs on Bun, whose documented native SQLite module exposes the contract used above.
	const sqlite = require("bun:sqlite") as BunSqlite;
	return new sqlite.Database(path, options.readOnly === true ? { readonly: true } : undefined);
}

function openNodeSqlite(path: string, options: SqliteOpenOptions): RawSqlDatabase {
	// SAFETY: Node 22.5+ exposes node:sqlite; the structural contract is limited to APIs used by the archive.
	const sqlite = require("node:sqlite") as NodeSqlite;
	return new sqlite.DatabaseSync(
		path,
		options.readOnly === true ? { timeout: 5000, readOnly: true } : { timeout: 5000 },
	);
}

function normalizeSqlite(database: RawSqlDatabase): SqlDatabase {
	return {
		exec: (sql) => database.exec(sql),
		prepare: (sql) => {
			const statement = database.prepare(sql);
			return {
				run: (...parameters) => statement.run(...parameters),
				get: (...parameters) => {
					const row = statement.get(...parameters);
					return row === null ? undefined : row;
				},
				all: (...parameters) => statement.all(...parameters),
			};
		},
		close: () => database.close(),
	};
}
