const conventionalCommitTitlePattern = /^[a-z][a-z0-9-]*(?:\([^\s()]+\))?!?: \S.*$/;

export function isConventionalCommitTitle(title: string): boolean {
	return !/[\r\n]/.test(title) && conventionalCommitTitlePattern.test(title);
}
