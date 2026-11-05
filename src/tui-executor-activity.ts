import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Keybinding, type KeybindingsManager, ScrollView, Spacer, Text } from "@earendil-works/pi-tui";
import type { WorkView } from "./model.js";
import type { RuntimeActivityEntry } from "./ports.js";
import type { ApplicationService } from "./service.js";
import type { WorkActivitySnapshot, WorkActivitySubscription } from "./service-runtime-activity.js";
import {
	addHeading,
	addPanelKeybindings,
	isPanelBack,
	PANEL_BACK_FOOTER,
	scrollOverlay,
	scrollPage,
	showTextPage,
} from "./tui-pages.js";

function openActivity(
	service: ApplicationService,
	work: WorkView,
	onChange: () => void,
): WorkActivitySubscription | undefined {
	try {
		return service.observeExecutor(
			work.workId,
			{
				actor: "user",
				commandId: `tui:activity:${work.workId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			onChange,
		);
	} catch {
		return undefined;
	}
}

function keyHint(keys: KeybindingsManager, binding: Keybinding): string {
	return keys.getKeys(binding)[0] ?? "unbound";
}

function scrollHints(keys: KeybindingsManager): string {
	const up = keyHint(keys, "tui.editor.cursorUp");
	const down = keyHint(keys, "tui.editor.cursorDown");
	const pageUp = keyHint(keys, "tui.editor.pageUp");
	const pageDown = keyHint(keys, "tui.editor.pageDown");
	return `${up}/${down} scroll  ${pageUp}/${pageDown} page`;
}

function activityEntry(entry: RuntimeActivityEntry): string {
	if (entry.kind === "tool") return `  ${entry.name} (${entry.phase})`;
	return entry.truncated ? `${entry.text}\n[Message truncated]` : entry.text;
}

function activityStatus(snapshot: WorkActivitySnapshot): string {
	if (snapshot.state === "detached") return "Detached: this Work no longer has the same Executor session.";
	const status = {
		attached: "Attached. Waiting for activity or a turn.",
		ended: "Session ended. Showing retained activity.",
	}[snapshot.state];
	const discarded = snapshot.discarded === 0 ? "" : `\nEarlier entries discarded: ${snapshot.discarded}.`;
	return `${status}\nRecent in-memory activity may be incomplete.${discarded}`;
}

function activityText(snapshot: WorkActivitySnapshot): string {
	if (snapshot.state === "detached") return "";
	return snapshot.entries.length === 0 ? "No activity observed." : snapshot.entries.map(activityEntry).join("\n");
}

export async function showExecutorActivity(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
): Promise<void> {
	let refresh = (): void => {};
	const subscription = openActivity(service, work, () => refresh());
	if (subscription === undefined)
		return showTextPage(context, "Executor activity unavailable", [
			"The current Executor session is not attached. Return to Work and retry.",
		]);
	let open = true;
	let cancelTimer = (): void => {};
	const close = (): void => {
		if (!open) return;
		open = false;
		cancelTimer();
		subscription.close();
	};
	try {
		await context.ui.custom<void>(
			(tui, theme, keys, done) => {
				let disposed = false;
				const body = new Text("", 1, 0);
				const status = new Text("", 1, 0);
				const header = new Container();
				addHeading(header, theme, "Executor activity");
				header.addChild(status);
				header.addChild(new Spacer(1));
				const scroll = new ScrollView(body, { overscroll: "contain", scrollbar: "auto", follow: "end" });
				const footer = new Container();
				addPanelKeybindings(footer, theme, `${PANEL_BACK_FOOTER}  ${scrollHints(keys)}`);
				const page = scrollOverlay(tui, scroll, footer, header);
				refresh = (): void => {
					if (disposed) return;
					try {
						const snapshot = subscription.snapshot();
						status.setText(theme.fg("muted", activityStatus(snapshot)));
						body.setText(theme.fg("muted", activityText(snapshot)));
					} catch {
						status.setText(theme.fg("muted", "Activity is unavailable. Return to Work and retry."));
						body.setText("");
					}
					tui.requestRender();
				};
				const timer = setInterval(refresh, 500);
				cancelTimer = () => clearInterval(timer);
				timer.unref();
				refresh();
				return Object.assign(page, {
					handleInput: (data: string) => {
						if (scrollPage(scroll, data)) return tui.requestRender();
						if (isPanelBack(data)) done();
					},
					dispose: () => {
						disposed = true;
						close();
					},
				});
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
		);
	} finally {
		refresh = (): void => {};
		close();
	}
}
