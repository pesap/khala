import test from "node:test";
import assert from "node:assert/strict";

import { formatKhalaStatusLabel } from "../../extensions/runtime/ui.ts";

function themedCtx(): never {
  return {
    hasUI: true,
    ui: {
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      },
    },
  } as never;
}

test("khala-mode status label uses Pi theme colors by mode", () => {
  assert.equal(formatKhalaStatusLabel(themedCtx(), "monitor"), "khala-mode: <accent>monitor</accent>");
  assert.equal(formatKhalaStatusLabel(themedCtx(), "warn"), "khala-mode: <warning>warn</warning>");
  assert.equal(formatKhalaStatusLabel(themedCtx(), "enforce"), "khala-mode: <error>enforce</error>");
});

test("khala-mode status label stays plain without UI", () => {
  assert.equal(
    formatKhalaStatusLabel({ hasUI: false, ui: {} } as never, "warn"),
    "khala-mode: warn",
  );
});
