import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitWorktreeProvider } from "../dist/src/vcs-git-worktree.js";

test("Git publication failures preserve bounded, redacted child diagnostics", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-git-diagnostic-"));
	const bin = join(root, "bin");
	const sandboxPath = join(root, "sandbox");
	mkdirSync(bin);
	mkdirSync(sandboxPath);
	writeFileSync(
		join(bin, "git"),
		`#!/usr/bin/env node
const [command] = process.argv.slice(2);
if (command === "branch") process.stdout.write("khala/review\\n");
else if (command === "commit") process.exit(0);
else if (command === "rev-parse") process.stdout.write("planning-commit\\n");
else if (command === "push") {
  process.stderr.write("remote: hook rejected token=super-secret\\n" + "remote: authorization=Bearer bearer-secret\\n" + "x".repeat(10000));
  process.stdout.write("push summary for https://user:secret@example.invalid/repo?access_token=access-secret&OAuth_Token=oauth-secret&CREDENTIAL=credential-secret&client_SECRET=client-secret&apiKey=api-key-secret&user_credentials=user-credential-secret&aws_secret_access_key=aws-access-secret\\n");
  process.stdout.write("fatal: unable to access 'https://host/repo?oauth_access_token=nested-secret': 403\\n");
  process.exit(1);
}
`,
	);
	chmodSync(join(bin, "git"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	try {
		const provider = createGitWorktreeProvider(join(root, "worktrees"), "khala-test/");
		await assert.rejects(
			provider.prepareReview({
				sandbox: { path: sandboxPath, name: "review", projectPath: root },
				name: "Review",
				workId: "work-review",
				executionId: "execution-review",
				mission: "Publish the review.",
				publish: true,
			}),
			(error) => {
				assert.match(error.message, /git push --set-upstream origin khala\/review failed:/);
				assert.match(error.message, /stderr: remote: hook rejected token=\[REDACTED\]/);
				assert.match(error.message, /authorization=Bearer \[REDACTED\]/);
				assert.match(
					error.message,
					/stdout: push summary for https:\/\/\[REDACTED\]@example\.invalid\/repo\?access_token=\[REDACTED\]&OAuth_Token=\[REDACTED\]&CREDENTIAL=\[REDACTED\]&client_SECRET=\[REDACTED\]&apiKey=\[REDACTED\]&user_credentials=\[REDACTED\]&aws_secret_access_key=\[REDACTED\]/,
				);
				assert.match(error.message, /fatal: unable to access 'https:\/\/host\/repo\?oauth_access_token=\[REDACTED\]': 403/);
				assert.ok(error.message.length < 6000);
				assert.doesNotMatch(
					error.message,
					/super-secret|user:secret|access-secret|oauth-secret|credential-secret|client-secret|api-key-secret|user-credential-secret|aws-access-secret|bearer-secret|nested-secret/,
				);
				assert.match(error.message, /truncated/);
				return true;
			},
		);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
});
