import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverCopilotMiniId,
  resetKhalaProfileDiscoveryForTests,
  resolveKhalaProfile,
} from "../../extensions/runtime/khala-profiles.ts";

async function withFakePi(
  script: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-profiles-test-"));
  const previousPath = process.env.PATH;
  try {
    const piPath = path.join(tempDir, "pi");
    await writeFile(piPath, script, { mode: 0o755 });
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;
    resetKhalaProfileDiscoveryForTests();
    await fn();
  } finally {
    resetKhalaProfileDiscoveryForTests();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("discovers and caches the legacy Copilot 5.4 mini profile id", async () => {
  const callLog = path.join(
    tmpdir(),
    `khala-profiles-call-log-${process.pid}-${Date.now()}`,
  );
  try {
    await withFakePi(
      `#!/usr/bin/env bash
set -euo pipefail
printf call >> ${JSON.stringify(callLog)}
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model context max-out thinking images\n'
  printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
fi
`,
      () => {
        const first = discoverCopilotMiniId();
        const second = discoverCopilotMiniId();
        assert.deepEqual(first, { model: "github-copilot/gpt-5.4-mini" });
        assert.equal(second.model, "github-copilot/gpt-5.4-mini");
        const profile = resolveKhalaProfile("agents");
        assert.equal(profile.name, "agents");
        assert.equal(profile.model, "NLR/HALO Devstral 123B");
        assert.equal(profile.thinkingLevel, "off");
        assert.equal(profile.status, "ok");
      },
    );
    assert.equal(await readFile(callLog, "utf8"), "call");
  } finally {
    await rm(callLog, { force: true });
  }
});

test("discovers a usable non-Copilot 5.4 mini provider without changing NLR defaults", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model context max-out thinking images\n'
  printf 'openai-codex gpt-5.4-mini 272K 128K yes yes\n'
  printf 'openrouter openai/gpt-5.4-mini 400K 128K yes yes\n'
fi
`,
    () => {
      const discovered = discoverCopilotMiniId();
      assert.deepEqual(discovered, { model: "openai-codex/gpt-5.4-mini" });

      const profile = resolveKhalaProfile("development");
      assert.equal(profile.model, "NLR/HALO Devstral 123B");
      assert.equal(profile.thinkingLevel, "off");
      assert.equal(profile.status, "ok");
    },
  );
});

test("uses NLR HALO builtin profiles even when legacy Pi discovery misses 5.4 mini", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4 400K 128K yes yes\n'
`,
    () => {
      const profile = resolveKhalaProfile("development");
      assert.equal(profile.model, "NLR/HALO Devstral 123B");
      assert.equal(profile.thinkingLevel, "off");
      assert.equal(profile.status, "ok");
    },
  );
});
