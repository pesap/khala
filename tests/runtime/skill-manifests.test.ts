import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

test("packaged skill manifests match their directory names", async () => {
  const repoRoot = process.cwd();
  const skillsDir = path.join(repoRoot, "skills");
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const invalid: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    let skillText = "";
    try {
      skillText = await fs.readFile(skillFile, "utf8");
    } catch {
      invalid.push(`${entry.name}: missing SKILL.md`);
      continue;
    }

    const frontmatter = skillText.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!frontmatter) {
      invalid.push(`${entry.name}: missing YAML frontmatter`);
      continue;
    }

    const parsed = loadYaml(frontmatter[1]);
    if (!isRecord(parsed)) {
      invalid.push(`${entry.name}: invalid YAML frontmatter`);
      continue;
    }
    if (parsed.name !== entry.name) {
      invalid.push(`${entry.name}: frontmatter name must be ${entry.name}`);
    }
    if (typeof parsed.description !== "string" || !parsed.description.trim()) {
      invalid.push(`${entry.name}: missing description`);
    }
  }

  assert.deepEqual(invalid, []);
});
