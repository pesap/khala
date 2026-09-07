import { closeSync, constants, existsSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqlDatabase } from "./sqlite.js";

const SIDECAR_SUFFIX = ".supervision.sqlite";
const SIDECAR_MODE = 0o600;
const LOCK_TABLE = "khala_supervision_lock";

export class SQLiteSupervisionLock {
	private readonly path: string;
	private database: SqlDatabase | undefined;

	constructor(archivePath: string) {
		this.path = `${archivePath}${SIDECAR_SUFFIX}`;
		const root = lstatSync(dirname(archivePath));
		if (!root.isDirectory()) throw new Error(`Archive root ${dirname(archivePath)} is not a directory.`);
	}

	acquire(): boolean {
		if (this.database !== undefined) return true;
		ensureSidecarFile(this.path);
		const database = openSqlite(this.path);
		return this.tryAcquire(database);
	}

	private tryAcquire(database: SqlDatabase): boolean {
		try {
			database.exec("PRAGMA busy_timeout = 0");
			ensureLockTable(database);
			database.exec("BEGIN IMMEDIATE");
			this.database = database;
			return true;
		} catch (error) {
			database.close();
			if (error instanceof Error && isSqliteBusyOrLocked(error)) return false;
			throw error;
		}
	}

	release(): void {
		const database = this.database;
		this.database = undefined;
		if (database !== undefined) database.close();
	}
}

function ensureLockTable(database: SqlDatabase): void {
	const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(LOCK_TABLE);
	if (table !== undefined) return;
	if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== undefined) {
		throw new Error("Archive supervision sidecar is not a Khala supervision database.");
	}
	database.exec(`CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1))`);
}

function ensureSidecarFile(path: string): void {
	createSidecarIfMissing(path);
	validateSidecarFile(path);
	validateSidecarDatabase(path);
}

function validateSidecarFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile()) throw new Error(`Archive supervision sidecar ${path} is not a regular file.`);
	if ((stat.mode & 0o777) !== SIDECAR_MODE) throw new Error(`Archive supervision sidecar ${path} must have mode 0600.`);
}

function validateSidecarDatabase(path: string): void {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const header = Buffer.alloc(16);
		const bytes = readSync(descriptor, header, 0, header.length, 0);
		// An empty reserved sidecar can remain if its creator exits before SQLite initializes it.
		if (bytes > 0 && header.toString() !== "SQLite format 3\u0000") {
			throw new Error(`Archive supervision sidecar ${path} is not a Khala SQLite database.`);
		}
	} finally {
		closeSync(descriptor);
	}
}

function createSidecarIfMissing(path: string): void {
	if (existsSync(path)) return;
	writeSidecar(path);
}

function writeSidecar(path: string): void {
	try {
		writeFileSync(path, "", { encoding: "utf8", mode: SIDECAR_MODE, flag: "wx" });
	} catch (error) {
		if (error instanceof Error && errorCode(error) === "EEXIST") return;
		throw error;
	}
}

function isSqliteBusyOrLocked(error: Error): boolean {
	return isNamedSqliteBusy(error) || isNodeSqliteBusy(error);
}

function isNamedSqliteBusy(error: Error): boolean {
	const code = errorCode(error);
	return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function isNodeSqliteBusy(error: Error): boolean {
	const errcode = errorNumber(error, "errcode");
	return errorCode(error) === "ERR_SQLITE_ERROR" && (errcode === 5 || errcode === 6);
}

function errorNumber(error: Error, property: string): number | undefined {
	const value = Object.getOwnPropertyDescriptor(error, property)?.value;
	return value === Number(value) ? Number(value) : undefined;
}

function errorCode(error: Error): string | undefined {
	const value = Object.getOwnPropertyDescriptor(error, "code")?.value;
	return value === undefined || value !== String(value) ? undefined : String(value);
}
