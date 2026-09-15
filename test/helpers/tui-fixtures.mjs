import { getKeybindings } from "@earendil-works/pi-tui";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};
const tuiKeybindings = getKeybindings();

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

export { nextTurn, theme, tuiKeybindings };
