import { normalizeWhitespace } from "./text.ts";

export function removeFlag(input: string, pattern: RegExp): { value: string; match: RegExpMatchArray | null } {
  const match = input.match(pattern);
  if (!match) return { value: input, match: null };
  return { value: normalizeWhitespace(input.replace(pattern, " ")), match };
}
