import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { exists } from "../lib/io.ts";
import { LEARNING_STORE_DIRNAME } from "../lib/constants.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_DIR = path.join(PACKAGE_ROOT, "runtime");
const USER_STATE_DIR = path.join(homedir(), ".pi", LEARNING_STORE_DIRNAME);
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(homedir(), ".pi", "agent");
const USER_CONFIG_DIR = path.join(PI_AGENT_DIR, LEARNING_STORE_DIRNAME);
const WORKFLOW_MODEL_CONFIG_FILE = "workflow-model.yaml";

export const RUNTIME_PATHS = {
  packageRoot: PACKAGE_ROOT,
  runtimeDir: RUNTIME_DIR,
  skillflowsDir: path.join(PACKAGE_ROOT, "workflows"),
  commandsDir: path.join(PACKAGE_ROOT, "commands"),
  interceptedCommandsDir: path.join(PACKAGE_ROOT, "intercepted-commands"),
  hooksDir: path.join(RUNTIME_DIR, "hooks"),
  hooksConfigPath: path.join(RUNTIME_DIR, "hooks", "hooks.yaml"),
  runtimeDailyLogPath: path.join(USER_STATE_DIR, "runtime", "live", "dailylog.md"),
  packageSkillsPath: path.join(PACKAGE_ROOT, "skills"),
  profileConfigPath: path.join(RUNTIME_DIR, "profile.yaml"),
  firstPrinciplesConfigPath: path.join(RUNTIME_DIR, "compliance", "first-principles-gate.yaml"),
  workflowModelConfigPath: path.join(USER_CONFIG_DIR, WORKFLOW_MODEL_CONFIG_FILE),
} as const;

export async function resolveWorkflowModelConfigPath(cwd: string, projectTrusted: boolean): Promise<string> {
  const projectConfigPath = path.join(cwd, ".pi", LEARNING_STORE_DIRNAME, WORKFLOW_MODEL_CONFIG_FILE);
  if (projectTrusted && await exists(projectConfigPath)) return projectConfigPath;
  return RUNTIME_PATHS.workflowModelConfigPath;
}
