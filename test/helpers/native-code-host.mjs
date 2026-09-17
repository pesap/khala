import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function createReview(args, statePath) {
	const branch = args[args.indexOf("--head") + 1];
	const row = {
		number: 42, url: "https://github.com/fixture/native-workflow/pull/42", state: "OPEN", isDraft: true,
		headRefName: branch, baseRefName: "main", headRefOid: git("rev-parse", branch), baseRefOid: git("rev-parse", "main"),
		mergedAt: null, reviewDecision: "", statusCheckRollup: [], comments: [], reviews: [],
	};
	writeFileSync(statePath, JSON.stringify(row));
	return row.url;
}

export function runCodeHostFixture(args, statePath) {
	const readReview = () => {
		const review = JSON.parse(readFileSync(statePath, "utf8"));
		if (review.state === "OPEN") review.headRefOid = git("--git-dir", join(dirname(statePath), "remote.git"), "rev-parse", review.headRefName);
		return JSON.stringify(review);
	};
	const routes = new Map([
		["api user", () => "fixture-user"],
		["repo view", () => "fixture/native-workflow"],
		["pr list", () => existsSync(statePath) ? `[${readReview()}]` : "[]"],
		["pr create", () => createReview(args, statePath)],
		["pr view", readReview],
		["pr diff", () => git("diff", "main", JSON.parse(readFileSync(statePath, "utf8")).headRefName)],
		["api repos/fixture/native-workflow/pulls/42/comments", () => "[]"],
	]);
	const route = routes.get(`${args[0]} ${args[1]}`);
	if (route === undefined) throw new Error(`Unexpected code-host request: ${args.join(" ")}`);
	process.stdout.write(`${route()}\n`);
}
