/* biome-ignore-all lint/style/noProcessEnv: NO_COLOR is the conventional CLI opt-out. */
/* biome-ignore-all lint/complexity/useLiteralKeys: ProcessEnv is intentionally accessed through its index signature. */

import process, { stdout as output } from "node:process";

const ANSI = {
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	reset: "\u001b[0m",
} as const;
const LABEL_WIDTH = 18;

function style(code: string, text: string): string {
	if (!output.isTTY || process.env["NO_COLOR"] !== undefined) {
		return text;
	}
	return `${code}${text}${ANSI.reset}`;
}

function bold(text: string): string {
	return style(ANSI.bold, text);
}

function dim(text: string): string {
	return style(ANSI.dim, text);
}

function green(text: string): string {
	return style(ANSI.green, text);
}

function yellow(text: string): string {
	return style(ANSI.yellow, text);
}

function titleLine(title: string): string {
	return `${bold(title)} ${dim("────────────────────────────────────────────────────────")}`;
}

function row(marker: string, label: string, value: string): string {
	return `  ${marker} ${label.padEnd(LABEL_WIDTH)}${value}`;
}

export { bold, dim, green, row, titleLine, yellow };
