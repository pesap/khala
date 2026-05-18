import {
  BLOCKED_COMMAND_PATTERNS,
  UV_INSTALL_GUIDANCE,
} from "../lib/constants.ts";

function formatBlockedCommandMessage(
  headline: string,
  guidance: string[],
): string {
  return [headline, "", ...guidance.map((line) => `  ${line}`), ""].join("\n");
}

function stripNonExecutableShellText(command: string): string {
  let sanitized = command;

  // Remove heredoc bodies to avoid matching blocked tokens inside embedded scripts.
  // Example: node - <<'NODE' ... /usr/bin/python3 ... NODE
  const heredocPattern =
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\t ]*\n[\s\S]*?\n\2(?=\n|$)/g;
  sanitized = sanitized.replace(heredocPattern, "");

  // Replace quoted strings with spaces (same length-ish not required for regex checks).
  sanitized = sanitized
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

  return sanitized;
}

export function getBlockedCommandMessage(command: string): string | null {
  const executableText = stripNonExecutableShellText(command);

  if (BLOCKED_COMMAND_PATTERNS.pip.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: pip is disabled while khala is active. Use uv instead:",
      UV_INSTALL_GUIDANCE,
    );
  }

  if (BLOCKED_COMMAND_PATTERNS.pip3.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: pip3 is disabled while khala is active. Use uv instead:",
      UV_INSTALL_GUIDANCE,
    );
  }

  if (BLOCKED_COMMAND_PATTERNS.poetry.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: poetry is disabled while khala is active. Use uv instead:",
      [
        "To initialize a project: uv init",
        "To add a dependency: uv add PACKAGE",
        "To sync dependencies: uv sync",
        "To run commands: uv run COMMAND",
      ],
    );
  }

  if (BLOCKED_COMMAND_PATTERNS.pythonPip.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: 'python -m pip' is disabled while khala is active. Use uv instead:",
      UV_INSTALL_GUIDANCE,
    );
  }

  if (BLOCKED_COMMAND_PATTERNS.pythonVenv.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: 'python -m venv' is disabled while khala is active. Use uv instead:",
      ["To create a virtual environment: uv venv"],
    );
  }

  if (BLOCKED_COMMAND_PATTERNS.pythonPyCompile.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: 'python -m py_compile' is disabled while khala is active because it writes .pyc files to __pycache__.",
      [
        "To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
      ],
    );
  }

  if (BLOCKED_COMMAND_PATTERNS.pythonExplicitPath.test(executableText)) {
    return formatBlockedCommandMessage(
      "Error: Direct path-qualified Python executables (for example `/usr/bin/python3`) are disabled while khala is active.",
      [
        "Use `python` or `python3` so khala can route through uv.",
        "For explicit interpreter control, run: uv run python ...",
      ],
    );
  }

  return null;
}
