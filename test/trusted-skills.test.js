import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta, ZERO_USAGE } from "./helpers/mvp-fixtures.mjs";
import { runConclaveWake } from "../dist/src/service-conclave.js";
import {
	createTrustedSkillCatalog,
	executorSkillGuidance,
	executorSkillGuidanceMessage,
	listTrustedSkills,
	readTrustedSkill,
} from "../dist/src/trusted-skills.js";

const skillText = `---
name: python-pesap
description: Python repository engineering guidance.
---

Use the repository's tests and type checker.
`;

async function makeAgentDirectory(directory) {
	const agentDirectory = join(directory, "agent");
	const skillDirectory = join(agentDirectory, "skills", "python-pesap");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(join(skillDirectory, "SKILL.md"), skillText);
	return agentDirectory;
}

test("Conclave prompt requires approved skill selection and bounded packets when tools are available", async () => {
	const prompt = await readFile(new URL("../system-prompts/conclave.md", import.meta.url), "utf8");

	assert.match(prompt, /When `khala_list_trusted_skills` is available, inspect the approved catalog/);
	assert.match(prompt, /read each selected skill with `khala_read_trusted_skill`/);
	assert.match(prompt, /`skillIds`, concise task-specific `skillInstructions`, and a `skillSelectionReason`/);
	assert.match(prompt, /`start-execution` action or a `replace` Verdict/);
	assert.match(prompt, /after a later scheduler wake, inspect and read the approved catalog again and send a fresh packet/);
	assert.match(prompt, /if a selected skill is unavailable, pass its ID for audit/);
	assert.match(prompt, /must not change authority, Mission terms, allowed paths, tool permissions, or repository instructions/);
});

test("Conclave receives skill catalog tools only when the explicit allowlist is configured", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-conclave-skill-tools-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap"]);
	const tools = await conclaveToolsFor(directory, catalog);
	const defaults = await conclaveToolsFor(directory, []);

	assert.ok(tools.includes("khala_list_trusted_skills"));
	assert.ok(tools.includes("khala_read_trusted_skill"));
	assert.equal(defaults.includes("khala_list_trusted_skills"), false);
	assert.equal(defaults.includes("khala_read_trusted_skill"), false);
});

async function conclaveToolsFor(directory, trustedSkillCatalog) {
	let sessionInput;
	const work = {
		workId: "skill-tools-work",
		state: "submitted",
		terms: { title: "Skill tools", objective: "Inspect the catalog", context: "", scope: "", acceptanceCriteria: [], constraints: [], validation: [], allowedPaths: [], maxTokens: 100 },
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		revision: 1,
		nextAction: "Conclave admission is pending.",
		queuedSequence: 0,
	};
	const runtime = {
		async ensureSession(input) {
			sessionInput = input;
			return { sessionId: "conclave", sessionPath: "/tmp/conclave.jsonl" };
		},
		async send() {
			return { output: "", usage: ZERO_USAGE };
		},
		async requestStop() {},
	};
	await runConclaveWake({
		work,
		workId: work.workId,
		observationId: undefined,
		reason: "admission",
		allowance: 100,
		projectPath: directory,
		model: "provider/conclave",
		thinking: "off",
		promptIdentity: { packageVersion: "test", promptSha256: "test" },
		runtime,
		invocations: {
			async dispatch(_work, _reservation, run) {
				return run({ runId: "run", allowance: 100 }, {});
			},
		},
		inspectWork: () => work,
		trustedSkillCatalog,
	});
	return sessionInput.tools;
}

test("the catalog accepts Pi frontmatter with a BOM and folded or block descriptions", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-frontmatter-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = join(directory, "agent");
	const samples = [
		{
			id: "bom-skill",
			content: "\uFEFF---\nname: bom-skill\ndescription: BOM metadata.\n---\nInstructions.",
			description: "BOM metadata.",
		},
		{
			id: "folded-skill",
			content: "---\nname: folded-skill\ndescription: >\n  Fold line one\n  onto line two.\n---\nInstructions.",
			description: "Fold line one onto line two.\n",
		},
		{
			id: "block-skill",
			content: "---\nname: block-skill\ndescription: |\n  Preserve line one.\n  Preserve line two.\n---\nInstructions.",
			description: "Preserve line one.\nPreserve line two.\n",
		},
	];
	for (const sample of samples) {
		const skillDirectory = join(agentDirectory, "skills", sample.id);
		await mkdir(skillDirectory, { recursive: true });
		await writeFile(join(skillDirectory, "SKILL.md"), sample.content);
	}

	const catalog = createTrustedSkillCatalog(agentDirectory, samples.map(({ id }) => id));
	assert.deepEqual(catalog.map((skill) =>
		skill.available
			? { id: skill.id, name: skill.name, description: skill.description }
			: { id: skill.id, reason: skill.reason },
	), samples.map(({ id, description }) => ({ id, name: id, description })));
});

test("the catalog requires Pi skill names but allows names independent of directory IDs", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-name-metadata-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = join(directory, "agent");
	const missingName = join(agentDirectory, "skills", "missing-name");
	const differentName = join(agentDirectory, "skills", "directory-id");
	await mkdir(missingName, { recursive: true });
	await mkdir(differentName, { recursive: true });
	await writeFile(join(missingName, "SKILL.md"), `---
description: Missing required name.
---
Instructions.`);
	await writeFile(join(differentName, "SKILL.md"), `---
name: shared-skill-name
description: Pi permits a name independent of the directory.
---
Instructions.`);

	const catalog = createTrustedSkillCatalog(agentDirectory, ["missing-name", "directory-id"]);
	assert.deepEqual(catalog.map((skill) =>
		skill.available
			? { id: skill.id, available: true, name: skill.name }
			: { id: skill.id, available: false, reason: skill.reason },
	), [
		{ id: "missing-name", available: false, reason: "The approved SKILL.md has invalid name or description metadata." },
		{ id: "directory-id", available: true, name: "shared-skill-name" },
	]);
});

test("the catalog exposes only explicitly allowlisted global skills and records content identity", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-trusted-skills-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const projectSkill = join(directory, "project", ".pi", "skills", "rogue");
	await mkdir(projectSkill, { recursive: true });
	await writeFile(join(projectSkill, "SKILL.md"), "untrusted project guidance");

	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap"]);
	assert.deepEqual(listTrustedSkills(catalog), [{
		id: "python-pesap",
		available: true,
		name: "python-pesap",
		description: "Python repository engineering guidance.",
		sha256: createHash("sha256").update(skillText).digest("hex"),
	}]);
	assert.equal(readTrustedSkill(catalog, "rogue"), undefined);
	assert.throws(
		() => executorSkillGuidance(catalog, { skillIds: ["rogue"], skillInstructions: "Use the project skill." }),
		/ not in the trusted allowlist/,
	);
	assert.match(executorSkillGuidance(catalog, { skillIds: [] }).reason, /No approved skill was selected/);
	assert.equal(
		executorSkillGuidance(catalog, { skillIds: [], skillSelectionReason: "No skill applies to this Work." }).reason,
		"No skill applies to this Work.",
	);
	assert.equal(readTrustedSkill(catalog, "python-pesap").content, skillText);
});

test("unavailable allowlisted skills are recorded and produce repository-only guidance", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-missing-skill-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = createTrustedSkillCatalog(join(directory, "agent"), ["missing-skill"]);
	const guidance = executorSkillGuidance(catalog, {
		skillIds: ["missing-skill"],
		skillInstructions: "This guidance is unavailable and must not reach Executor.",
	});

	assert.deepEqual(listTrustedSkills(catalog), [{
		id: "missing-skill",
		available: false,
		reason: "The approved skill directory is unavailable.",
	}]);
	assert.equal(guidance.selected.length, 0);
	assert.match(guidance.reason, /selected approved skill.*unavailable/i);
	assert.deepEqual(guidance.unavailable.map(({ id }) => id), ["missing-skill"]);
	assert.equal(guidance.instructions, "");
	assert.equal(executorSkillGuidanceMessage(guidance), "");

	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { trustedSkillCatalog: catalog });
	try {
		const submitted = service.submitWork({
			title: "Unavailable approved skill",
			objective: "Start under repository guidance",
			scope: "Do not change the Mission",
			acceptanceCriteria: ["The instruction packet is omitted"],
			validation: ["node --test"],
			allowedPaths: ["src/target.ts"],
		}, meta("user", "missing-skill:submit", 0));
		const admitted = await service.perform({
			action: "admit",
			workId: submitted.workId,
			input: {},
			meta: meta("conclave", "missing-skill:admit", submitted.revision, submitted.workId),
		});
		assert.equal("error" in admitted, false);
		const started = await service.perform({
			action: "start-execution",
			workId: submitted.workId,
			input: {
				skillIds: ["missing-skill"],
				skillInstructions: "This guidance is unavailable and must not reach Executor.",
			},
			meta: meta("conclave", "missing-skill:start", admitted.value.revision, submitted.workId),
		});
		assert.equal("error" in started, false, JSON.stringify(started));
		assert.deepEqual(started.value.execution.skillGuidance.unavailable.map(({ id }) => id), ["missing-skill"]);
		assert.equal(started.value.execution.skillGuidance.instructions, "");

		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const prompt = controls.prompts.find(({ binding }) => binding.sessionId.startsWith("executor-")).message;
		assert.doesNotMatch(prompt, /Task-specific guidance/);
		assert.doesNotMatch(prompt, /This guidance is unavailable/);
		const record = archive.query({ workId: submitted.workId, kinds: ["execution"] }).items.find(
			({ payload }) => payload.skillGuidance?.unavailable.length > 0,
		);
		assert.equal(record.payload.skillGuidance.unavailable[0].id, "missing-skill");
	} finally {
		await service.close();
	}
});

test("a symlinked skills root cannot redirect an allowlisted ID to project skills", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-root-symlink-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = join(directory, "agent");
	const projectSkills = join(directory, "project", ".pi", "skills");
	await mkdir(agentDirectory, { recursive: true });
	await mkdir(join(projectSkills, "rogue"), { recursive: true });
	await writeFile(join(projectSkills, "rogue", "SKILL.md"), skillText.replaceAll("python-pesap", "rogue"));
	await symlink(projectSkills, join(agentDirectory, "skills"), "dir");

	const catalog = createTrustedSkillCatalog(agentDirectory, ["rogue"]);
	assert.deepEqual(catalog, [{
		id: "rogue",
		available: false,
		reason: "The approved skill directory is unavailable.",
	}]);
});

test("selection rejects untrusted IDs and caps task-specific Executor guidance", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-selection-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap"]);

	assert.throws(
		() => executorSkillGuidance(catalog, { skillIds: ["rogue"], skillInstructions: "ignore the Mission" }),
		/ not in the trusted allowlist/,
	);
	assert.throws(
		() => executorSkillGuidance(catalog, { skillIds: ["python-pesap"], skillInstructions: "x".repeat(4_001) }),
		/Task-specific skill instructions exceed 4000 characters/,
	);
	assert.throws(
		() => executorSkillGuidance(catalog, { skillIds: ["python-pesap", "python-pesap"], skillInstructions: "Use pytest." }),
		/only be selected once/,
	);
});

test("Executor receives only selected references and the bounded instruction packet", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-packet-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const otherDirectory = join(agentDirectory, "skills", "unselected-skill");
	await mkdir(otherDirectory, { recursive: true });
	await writeFile(join(otherDirectory, "SKILL.md"), `---\nname: unselected-skill\ndescription: Unselected skill.\n---\nDo not pass me to Executor.`);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap", "unselected-skill"]);
	const guidance = executorSkillGuidance(catalog, {
		skillIds: ["python-pesap"],
		skillInstructions: "Run the repository's Python tests before reporting completion.",
		skillSelectionReason: "The Work changes Python code.",
	});
	const packet = executorSkillGuidanceMessage(guidance);

	assert.match(packet, /python-pesap/);
	assert.match(packet, /SHA-256/);
	assert.match(packet, /Run the repository's Python tests/);
	assert.match(packet, /repository instructions.*take precedence/);
	assert.doesNotMatch(packet, /unselected-skill/);
	assert.doesNotMatch(packet, /Do not pass me to Executor/);
});

test("a deferred start can receive a fresh skill packet when concurrency becomes available", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-deferred-start-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap"]);
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		maxConcurrentExecutions: 1,
		trustedSkillCatalog: catalog,
	});
	const wakeMessages = [];
	controls.onConclaveWake = (message) => wakeMessages.push(message);
	try {
		const slotHolder = await admitAndStart(service, "skill-deferred-slot-holder");
		const submitted = service.submitWork({
			title: "Deferred skill selection",
			objective: "Update a TypeScript module",
			acceptanceCriteria: ["The behavior works"],
		}, meta("user", "skill-deferred:submit", 0));
		const admitted = await service.perform({
			action: "admit",
			workId: submitted.workId,
			input: {},
			meta: meta("conclave", "skill-deferred:admit", submitted.revision, submitted.workId),
		});
		assert.equal("error" in admitted, false, JSON.stringify(admitted));
		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const instruction = "Run the focused TypeScript tests before reporting completion.";
		const deferred = await service.perform({
			action: "start-execution",
			workId: submitted.workId,
			input: {
				skillIds: ["python-pesap"],
				skillInstructions: instruction,
				skillSelectionReason: "The Work changes TypeScript code.",
			},
			meta: meta("conclave", "skill-deferred:start", service.inspectWork(submitted.workId).revision, submitted.workId),
		});
		assert.equal("error" in deferred, false, JSON.stringify(deferred));
		assert.equal(deferred.value.state, "queued");
		assert.equal(deferred.value.execution, undefined);
		assert.equal(controls.sessions.some(({ input }) => input.role === "conclave" && input.tools.includes("khala_read_trusted_skill")), true);

		wakeMessages.length = 0;
		const progress = await service.perform({
			action: "record-signal",
			workId: slotHolder.workId,
			input: { kind: "progress", summary: "Release the Executor slot", evidence: ["progress"] },
			meta: meta("executor", "skill-deferred:release-progress", slotHolder.revision, slotHolder.workId, slotHolder.execution.executionId),
		});
		assert.equal("error" in progress, false, JSON.stringify(progress));
		const releasedSlot = await service.perform({
			action: "verdict",
			workId: slotHolder.workId,
			input: {
				decision: "reject",
				reason: "Release the Executor slot for the queued Work.",
				signalId: progress.value.lastSignal.signalId,
			},
			meta: meta("conclave", "skill-deferred:release-slot", progress.value.revision, slotHolder.workId),
		});
		assert.equal("error" in releasedSlot, false, JSON.stringify(releasedSlot));
		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(wakeMessages.some((message) => message.includes(submitted.workId)), true);

		const queued = service.inspectWork(submitted.workId);
		const started = await service.perform({
			action: "start-execution",
			workId: submitted.workId,
			input: {
				skillIds: ["python-pesap"],
				skillInstructions: instruction,
				skillSelectionReason: "The Work changes TypeScript code.",
			},
			meta: meta("conclave", "skill-deferred:retry", queued.revision, submitted.workId),
		});
		assert.equal("error" in started, false, JSON.stringify(started));
		assert.equal(started.value.execution.skillGuidance.instructions, instruction);
		assert.deepEqual(started.value.execution.skillGuidance.selected.map(({ id }) => id), ["python-pesap"]);

		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(controls.prompts.some(({ message }) => message.includes(instruction)));
	} finally {
		await service.close();
	}
});

test("replacement Executions receive fresh selected skill guidance", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-replacement-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap"]);
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { trustedSkillCatalog: catalog });
	try {
		const running = await admitAndStart(service, "skill-replacement");
		const progress = await service.perform({
			action: "record-signal",
			workId: running.workId,
			input: { kind: "progress", summary: "Ready for a fresh Execution", evidence: ["progress"] },
			meta: meta("executor", "skill-replacement:signal", running.revision, running.workId, running.execution.executionId),
		});
		const instruction = "For the replacement, run the focused TypeScript tests first.";
		const replacement = await service.perform({
			action: "verdict",
			workId: running.workId,
			input: {
				decision: "replace",
				reason: "Start a fresh Execution with relevant guidance.",
				signalId: progress.value.lastSignal.signalId,
				skillIds: ["python-pesap"],
				skillInstructions: instruction,
				skillSelectionReason: "The Work changes TypeScript code.",
			},
			meta: meta("conclave", "skill-replacement:verdict", progress.value.revision, running.workId),
		});
		assert.equal("error" in replacement, false, JSON.stringify(replacement));
		assert.notEqual(replacement.value.execution.executionId, running.execution.executionId);
		assert.equal(replacement.value.mission.missionId, running.mission.missionId);
		assert.equal(replacement.value.execution.skillGuidance.instructions, instruction);
		assert.deepEqual(replacement.value.execution.skillGuidance.selected.map(({ id }) => id), ["python-pesap"]);

		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const replacementPrompt = controls.prompts.find(({ message }) => message.includes(instruction));
		assert.ok(replacementPrompt);
		assert.match(replacementPrompt.message, /python-pesap/);
		const record = archive.query({ workId: running.workId, kinds: ["execution"] }).items.find(
			({ executionId, payload }) => executionId === replacement.value.execution.executionId && payload.skillGuidance !== undefined,
		);
		assert.equal(record.payload.skillGuidance.instructions, instruction);
	} finally {
		await service.close();
	}
});

test("replacement preparation recovery retains the selected skill packet", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-replacement-recovery-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap"]);
	let failNextPreparation = false;
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		trustedSkillCatalog: catalog,
		ports: {
			workspace: {
				async prepareSandbox(sandbox) {
					if (failNextPreparation) {
						failNextPreparation = false;
						throw new Error("Simulated preparation failure.");
					}
					return {
						schemaVersion: 1,
						kind: "no-node",
						sandboxPath: sandbox.path,
						baseCommit: sandbox.baseCommit,
						preparedAt: new Date().toISOString(),
					};
				},
			},
		},
	});
	try {
		const running = await admitAndStart(service, "skill-replacement-recovery");
		const progress = await service.perform({
			action: "record-signal",
			workId: running.workId,
			input: { kind: "progress", summary: "Ready for a fresh Execution", evidence: ["progress"] },
			meta: meta("executor", "skill-replacement-recovery:signal", running.revision, running.workId, running.execution.executionId),
		});
		const instruction = "For the recovered replacement, run the focused TypeScript tests first.";
		failNextPreparation = true;
		const replacement = await service.perform({
			action: "verdict",
			workId: running.workId,
			input: {
				decision: "replace",
				reason: "Start a fresh Execution with relevant guidance.",
				signalId: progress.value.lastSignal.signalId,
				skillIds: ["python-pesap"],
				skillInstructions: instruction,
				skillSelectionReason: "The Work changes TypeScript code.",
			},
			meta: meta("conclave", "skill-replacement-recovery:verdict", progress.value.revision, running.workId),
		});
		assert.equal("error" in replacement, false, JSON.stringify(replacement));
		assert.equal(replacement.value.preparation?.status, "waiting");
		assert.equal(replacement.value.preparation.skillGuidance.instructions, instruction);

		const recovered = await service.perform({
			action: "recover",
			workId: running.workId,
			input: {},
			meta: meta("user", "skill-replacement-recovery:recover", replacement.value.revision, running.workId),
		});
		assert.equal("error" in recovered, false, JSON.stringify(recovered));
		assert.equal(recovered.value.execution.skillGuidance.instructions, instruction);
		assert.deepEqual(recovered.value.execution.skillGuidance.selected.map(({ id }) => id), ["python-pesap"]);
		assert.equal(recovered.value.mission.missionId, running.mission.missionId);

		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const prompt = controls.prompts.find(({ message }) => message.includes(instruction));
		assert.ok(prompt);
		assert.match(prompt.message, /python-pesap/);
		const record = archive.query({ workId: running.workId, kinds: ["execution"] }).items.find(
			({ executionId, payload }) => executionId === recovered.value.execution.executionId && payload.skillGuidance !== undefined,
		);
		assert.equal(record.payload.skillGuidance.instructions, instruction);
	} finally {
		await service.close();
	}
});

test("starting an Execution records skill identity and propagates only selected guidance", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-skill-execution-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = await makeAgentDirectory(directory);
	const otherDirectory = join(agentDirectory, "skills", "unselected-skill");
	await mkdir(otherDirectory, { recursive: true });
	await writeFile(join(otherDirectory, "SKILL.md"), `---\nname: unselected-skill\ndescription: Unselected skill.\n---\nUnrelated guidance.`);
	const catalog = createTrustedSkillCatalog(agentDirectory, ["python-pesap", "unselected-skill"]);
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { trustedSkillCatalog: catalog });
	try {
		const submitted = service.submitWork({
			title: "Python change",
			objective: "Update a Python module",
			scope: "Change one permitted module",
			acceptanceCriteria: ["The Python behavior is correct"],
			validation: ["python -m pytest"],
			allowedPaths: ["src/target.py"],
		}, meta("user", "skill-execution:submit", 0));
		const admitted = await service.perform({
			action: "admit",
			workId: submitted.workId,
			input: {},
			meta: meta("conclave", "skill-execution:admit", submitted.revision, submitted.workId),
		});
		assert.equal("error" in admitted, false);
		const originalMission = admitted.value.mission;
		const started = await service.perform({
			action: "start-execution",
			workId: submitted.workId,
			input: {
				skillIds: ["python-pesap"],
				skillInstructions: "Run the repository's Python tests before reporting completion.",
				skillSelectionReason: "The Work changes Python code.",
			},
			meta: meta("conclave", "skill-execution:start", admitted.value.revision, submitted.workId),
		});
		assert.equal("error" in started, false, JSON.stringify(started));
		const guidance = started.value.execution.skillGuidance;
		assert.deepEqual(guidance.selected, [{
			id: "python-pesap",
			name: "python-pesap",
			sha256: createHash("sha256").update(skillText).digest("hex"),
		}]);
		assert.equal(guidance.instructions, "Run the repository's Python tests before reporting completion.");
		assert.equal(started.value.mission.missionId, originalMission.missionId);
		assert.deepEqual(started.value.mission.assignment.allowedPaths, ["src/target.py"]);

		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const executorSession = controls.sessions.find(({ input }) => input.role === "executor");
		assert.ok(executorSession);
		assert.equal(executorSession.input.tools.includes("khala_list_trusted_skills"), false);
		assert.equal(executorSession.input.tools.includes("khala_read_trusted_skill"), false);
		const prompt = controls.prompts.find(({ binding }) => binding.sessionId.startsWith("executor-")).message;
		assert.match(prompt, /python-pesap/);
		assert.match(prompt, /SHA-256/);
		assert.match(prompt, /Run the repository's Python tests/);
		assert.doesNotMatch(prompt, /unselected-skill/);

		const executionRecord = archive.query({ workId: submitted.workId, kinds: ["execution"] }).items.find(
			({ payload }) => payload.skillGuidance !== undefined,
		);
		assert.equal(executionRecord.payload.skillGuidance.selected[0].sha256, guidance.selected[0].sha256);
	} finally {
		await service.close();
	}
});
