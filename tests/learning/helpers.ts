import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LearningPaths } from "../../extensions/learning/store.ts";

export async function createTempLearningPaths(
  prefix = "khala-learning-",
): Promise<LearningPaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const memoryDir = path.join(root, "memory");
  const paths: LearningPaths = {
    root,
    memoryDir,
    runsDir: path.join(root, "runs"),
    workflowsDir: path.join(root, "workflows"),
    promptsDir: path.join(root, "prompts"),
    skillsDir: path.join(root, "skills"),
    archivedSkillsDir: path.join(root, "archive", "skills"),
    learningJsonl: path.join(memoryDir, "learning.jsonl"),
    lessonsJsonl: path.join(memoryDir, "lessons.jsonl"),
    khalaLearningJsonl: path.join(memoryDir, "khala-learning.jsonl"),
    memoryMd: path.join(memoryDir, "MEMORY.md"),
    promotionQueue: path.join(memoryDir, "promotion-queue.md"),
    stateJson: path.join(root, "state.json"),
    curatorReport: path.join(memoryDir, "skill-curator-report.md"),
  };

  await Promise.all([
    fs.mkdir(paths.memoryDir, { recursive: true }),
    fs.mkdir(paths.runsDir, { recursive: true }),
    fs.mkdir(paths.workflowsDir, { recursive: true }),
    fs.mkdir(paths.promptsDir, { recursive: true }),
    fs.mkdir(paths.skillsDir, { recursive: true }),
    fs.mkdir(paths.archivedSkillsDir, { recursive: true }),
  ]);

  return paths;
}
