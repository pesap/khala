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
  process.stderr.write("remote: hook rejected token=super-secret\\n" + "remote: authorization=Bearer bearer-secret\\n" + "remote: Authorization: Basic basic-header-secret\\n" + "remote: authorization=Bearer \\\"quoted-bearer-secret\\\"\\n" + "remote: Authorization: Basic 'quoted-basic-secret'\\n" + "remote: token=\\\"quoted-token-secret\\\" api-key='quoted-api-key-secret'\\n" + "remote: --token separated-token --api-key separated-api-key --password separated-password token separated-token-word --authorization Basic separated-basic\\n" + "x".repeat(10000));
  process.stdout.write("push summary for https://user:secret@example.invalid/repo?access_token=access-secret&OAuth_Token=oauth-secret&CREDENTIAL=credential-secret&client_SECRET=client-secret&apiKey=api-key-secret&user_credentials=user-credential-secret&aws_secret_access_key=aws-access-secret&AuTh=auth-secret&AUTHORIZATION=authorization-secret&x-amz-signature=signature-secret&X-AmZ-CrEdEnTiAl=credential-parameter-secret&X-AMZ-SECURITY-TOKEN=security-token-secret&AWSSecurityToken=aws-security-token-secret&securityToken=security-token-camel-secret&Signature=legacy-signature-secret&sIg=short-signature-secret&note=arbitrary-secret\\n");
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
				assert.match(error.message, /Authorization: Basic \[REDACTED\]/);
				assert.match(error.message, /authorization=Bearer \"\[REDACTED\]\"/);
				assert.match(error.message, /Authorization: Basic '\[REDACTED\]'/);
				assert.match(error.message, /token=\"\[REDACTED\]\" api-key='\[REDACTED\]'/);
				assert.match(
					error.message,
					/--token \[REDACTED\] --api-key \[REDACTED\] --password \[REDACTED\] token \[REDACTED\] --authorization Basic \[REDACTED\]/,
				);
				assert.match(
					error.message,
					/stdout: push summary for https:\/\/\[REDACTED\]@example\.invalid\/repo\?access_token=\[REDACTED\]&OAuth_Token=\[REDACTED\]&CREDENTIAL=\[REDACTED\]&client_SECRET=\[REDACTED\]&apiKey=\[REDACTED\]&user_credentials=\[REDACTED\]&aws_secret_access_key=\[REDACTED\]&AuTh=\[REDACTED\]&AUTHORIZATION=\[REDACTED\]&x-amz-signature=\[REDACTED\]&X-AmZ-CrEdEnTiAl=\[REDACTED\]&X-AMZ-SECURITY-TOKEN=\[REDACTED\]&AWSSecurityToken=\[REDACTED\]&securityToken=\[REDACTED\]&Signature=\[REDACTED\]&sIg=\[REDACTED\]&note=arbitrary-secret/,
				);
				assert.match(error.message, /fatal: unable to access 'https:\/\/host\/repo\?oauth_access_token=\[REDACTED\]': 403/);
				assert.match(error.message, /note=arbitrary-secret/);
				assert.ok(error.message.length < 6000);
				assert.doesNotMatch(
					error.message,
					/super-secret|user:secret|access-secret|oauth-secret|credential-secret|client-secret|api-key-secret|user-credential-secret|aws-access-secret|auth-secret|authorization-secret|signature-secret|credential-parameter-secret|security-token-secret|aws-security-token-secret|security-token-camel-secret|legacy-signature-secret|short-signature-secret|basic-header-secret|quoted-bearer-secret|quoted-basic-secret|quoted-token-secret|quoted-api-key-secret|separated-token|separated-api-key|separated-password|separated-token-word|separated-basic|nested-secret/,
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

test("GitHub publication failures redact Archive URL credentials and child diagnostics", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-gh-diagnostic-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stderr.write("GitHub rejected awsaccesskeyid=stderr-access AWSSECRETACCESSKEY=stderr-secret note=stderr-context\\n");
  process.stdout.write("response ACCESSKEYID=stdout-access aWsSeCrEtAcCeSsKeY=stdout-secret note=stdout-context\\n");
  process.exit(1);
}
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	const previousUrl =
		"https://github.com/pesap/khala/pull/16?AWSAccessKeyId=url-aws-access&accessKeyId=url-access&AWSSecretAccessKey=url-aws-secret&note=arbitrary-secret";
	try {
		const provider = createGitWorktreeProvider(join(root, "worktrees"), "khala-test/");
		await assert.rejects(
			provider.supersedePullRequest(previousUrl, "https://github.com/pesap/khala/pull/17"),
			(error) => {
				assert.match(error.message, /gh pr view/);
				assert.match(error.message, /AWSAccessKeyId=\[REDACTED\]/i);
				assert.match(error.message, /accessKeyId=\[REDACTED\]/i);
				assert.match(error.message, /AWSSecretAccessKey=\[REDACTED\]/i);
				assert.match(error.message, /note=arbitrary-secret/);
				assert.match(error.message, /stderr: GitHub rejected/);
				assert.match(error.message, /stdout: response/);
				assert.match(error.message, /note=stderr-context/);
				assert.match(error.message, /note=stdout-context/);
				assert.doesNotMatch(
					error.message,
					/url-aws-access|url-access|url-aws-secret|stderr-access|stderr-secret|stdout-access|stdout-secret/,
				);
				assert.ok(error.message.length < 6000);
				return true;
			},
		);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("superseded Pull Request semantic errors redact and bound Archive URLs", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-gh-semantic-diagnostic-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ state: "CLOSED", body: "", comments: [] }));
}
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	const previousUrl =
		`https://github.com/pesap/khala/pull/16?securityToken=previous-security-token-secret&note=${"arbitrary-archive-context-".repeat(80)}`;
	const successorUrl =
		"https://github.com/pesap/khala/pull/17?AWSSecurityToken=successor-security-token-secret&note=arbitrary-successor-context";
	try {
		const provider = createGitWorktreeProvider(join(root, "worktrees"), "khala-test/");
		await assert.rejects(
			provider.supersedePullRequest(previousUrl, successorUrl),
			(error) => {
				assert.match(error.message, /Predecessor Pull Request/);
				assert.match(error.message, /securityToken=\[REDACTED\]/i);
				assert.match(error.message, /AWSSecurityToken=\[REDACTED\]/i);
				assert.match(error.message, /note=arbitrary-successor-context/);
				assert.match(error.message, /truncated/);
				assert.doesNotMatch(error.message, /previous-security-token-secret|successor-security-token-secret/);
				assert.ok(error.message.length < 1300);
				return true;
			},
		);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
});
