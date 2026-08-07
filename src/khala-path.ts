import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Durable session records may cross a filesystem alias such as macOS's
// /var -> /private/var symlink. Compare physical paths without requiring the
// leaf to exist yet, because Pi can report its future session file at startup.
function canonicalFilesystemPath(path: string): string {
	const absolutePath = resolve(path);
	try {
		return realpathSync(absolutePath);
	} catch {
		const parentPath = dirname(absolutePath);
		try {
			return join(realpathSync(parentPath), basename(absolutePath));
		} catch {
			return absolutePath;
		}
	}
}

function sameFilesystemPath(left: string, right: string): boolean {
	return canonicalFilesystemPath(left) === canonicalFilesystemPath(right);
}

export { sameFilesystemPath };
