import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

type Model = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];
type ModelItem = Readonly<{ model: Model; provider: string; id: string }>;
type InputAction = "scope" | "up" | "down" | "confirm" | "cancel";

function modelItem(model: Model): ModelItem {
	return { model, provider: model.provider, id: model.id };
}

function modelSearchText(item: ModelItem): string {
	return `${item.id} ${item.provider} ${item.model.name}`;
}

export async function selectRoleModel(context: ExtensionContext, currentReference: string): Promise<Model | undefined> {
	const separator = currentReference.indexOf("/");
	const currentModel =
		separator <= 0
			? undefined
			: context.modelRegistry.find(currentReference.slice(0, separator), currentReference.slice(separator + 1));
	return context.ui.custom<Model | undefined>((tui, theme, keybindings, done) => {
		const component = new RoleModelSelector(tui, theme, keybindings, context, currentModel, context.scopedModels, done);
		return component;
	});
}

class RoleModelSelector extends Container {
	private readonly tui: { requestRender(): void };
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly context: ExtensionContext;
	private readonly done: (model: Model | undefined) => void;
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly currentModel: Model | undefined;
	private allModels: ModelItem[] = [];
	private scopedModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex = 0;
	private scope: "all" | "scoped";
	private errorMessage: string | undefined;
	private refreshMessage = "Refreshing model catalogs…";
	private closed = false;

	constructor(
		tui: { requestRender(): void },
		theme: Theme,
		keybindings: KeybindingsManager,
		context: ExtensionContext,
		currentModel: Model | undefined,
		scopedModels: ExtensionContext["scopedModels"],
		done: (model: Model | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.context = context;
		this.currentModel = currentModel;
		this.done = done;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.addChild(new Text(theme.fg("accent", theme.bold("Select role model")), 0, 0));
		this.addChild(new Spacer(1));
		if (scopedModels.length > 0) {
			this.addChild(new Text(this.scopeText(), 0, 0));
			this.addChild(new Text(theme.fg("muted", "Tab toggles all/scoped models"), 0, 0));
		} else {
			this.addChild(new Text(theme.fg("warning", "Only showing models from configured providers."), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.searchInput.focused = true;
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.loadModels(scopedModels);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Enter select · Esc cancel"), 0, 0));
		this.tui.requestRender();
		void this.refresh();
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	override render(width: number): string[] {
		return super.render(width);
	}

	handleInput(data: string): void {
		if (this.isBackspaceCancel(data)) return this.cancel();
		const action = this.inputAction(data);
		const handlers = {
			scope: () => this.toggleScope(),
			up: () => this.move(-1),
			down: () => this.move(1),
			confirm: () => this.select(),
			cancel: () => this.cancel(),
		} satisfies Record<InputAction, () => void>;
		const handler = action === undefined ? undefined : handlers[action];
		if (handler) return handler();
		this.searchInput.handleInput(data);
		this.filterModels(this.searchInput.getValue());
	}

	private isBackspaceCancel(data: string): boolean {
		return matchesKey(data, "backspace") && this.searchInput.getValue().length === 0;
	}

	private inputAction(data: string): InputAction | undefined {
		const actions = [
			["scope", "tui.input.tab"],
			["up", "tui.select.up"],
			["down", "tui.select.down"],
			["confirm", "tui.select.confirm"],
			["cancel", "tui.select.cancel"],
		] as const;
		return actions.find(([, binding]) => this.keybindings.matches(data, binding))?.[0];
	}

	private toggleScope(): void {
		if (this.scopedModels.length === 0) return;
		this.scope = this.scope === "all" ? "scoped" : "all";
		this.filterModels(this.searchInput.getValue());
	}

	dispose(): void {
		this.closed = true;
	}

	private loadModels(scopedModels: ExtensionContext["scopedModels"]): void {
		this.allModels = this.sortModels(this.context.modelRegistry.getAvailable().map(modelItem));
		this.scopedModels = this.sortModels(
			scopedModels
				.map(({ model }) => this.context.modelRegistry.find(model.provider, model.id))
				.filter((model): model is Model => model !== undefined)
				.map(modelItem),
		);
		this.filterModels(this.searchInput.getValue());
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		return [...models].sort(
			(left, right) =>
				Number(this.isCurrent(right)) - Number(this.isCurrent(left)) || left.provider.localeCompare(right.provider),
		);
	}

	private activeModels(): ModelItem[] {
		return this.scope === "scoped" ? this.scopedModels : this.allModels;
	}

	private filterModels(query: string): void {
		const active = this.activeModels();
		this.filteredModels = query ? fuzzyFilter(active, query, modelSearchText) : active;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		this.renderRows();
		this.renderFeedback();
		this.updateScopeText();
		this.tui.requestRender();
	}

	private renderRows(): void {
		const start = Math.max(0, Math.min(this.selectedIndex - 5, this.filteredModels.length - 10));
		const end = Math.min(start + 10, this.filteredModels.length);
		for (let index = start; index < end; index += 1) {
			const item = this.filteredModels[index];
			if (item) this.addModelRow(item, index === this.selectedIndex);
		}
	}

	private addModelRow(item: ModelItem, selected: boolean): void {
		const current = this.isCurrent(item);
		const cursor = selected ? "→ " : "  ";
		const marker = current ? "✓ " : "  ";
		const label = `${cursor}${marker}${item.id} ${this.theme.fg("muted", `[${item.provider}]`)}`;
		this.listContainer.addChild(new Text(label, 0, 0));
	}

	private isCurrent(item: ModelItem): boolean {
		return this.currentModel?.provider === item.provider && this.currentModel.id === item.id;
	}

	private renderFeedback(): void {
		this.addFeedback(this.filteredModels.length === 0 ? "  No matching models" : undefined, "muted");
		const selected = this.filteredModels[this.selectedIndex];
		this.addFeedback(selected ? `  Model Name: ${selected.model.name}` : undefined, "muted");
		this.addFeedback(this.errorMessage, "error");
		this.addFeedback(this.refreshMessage ? `  ${this.refreshMessage}` : undefined, "muted");
	}

	private addFeedback(text: string | undefined, color: "muted" | "error"): void {
		if (text) this.listContainer.addChild(new Text(this.theme.fg(color, text), 0, 0));
	}

	private updateScopeText(): void {
		const scope = this.children[2];
		if (scope instanceof Text && this.scopedModels.length > 0) scope.setText(this.scopeText());
	}

	private scopeText(): string {
		const all = this.scope === "all" ? this.theme.fg("accent", "all") : this.theme.fg("muted", "all");
		const scoped = this.scope === "scoped" ? this.theme.fg("accent", "scoped") : this.theme.fg("muted", "scoped");
		return this.theme.fg("muted", "Scope: ") + `${all}${this.theme.fg("muted", " | ")}${scoped}`;
	}

	private move(delta: number): void {
		if (this.filteredModels.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.filteredModels.length) % this.filteredModels.length;
		this.updateList();
	}

	private select(): void {
		const selected = this.filteredModels[this.selectedIndex];
		if (selected) this.finish(selected.model);
	}

	private cancel(): void {
		this.finish(undefined);
	}

	private finish(model: Model | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.done(model);
	}

	private async refresh(): Promise<void> {
		try {
			this.applyRefresh(await this.context.modelRegistry.refresh());
		} catch (error) {
			this.applyRefreshError(error instanceof Error ? error.message : String(error));
		}
	}

	private applyRefresh(result: Awaited<ReturnType<ExtensionContext["modelRegistry"]["refresh"]>>): void {
		if (this.closed) return;
		this.errorMessage =
			result.errors.size === 0
				? this.context.modelRegistry.getError()
				: `Could not refresh ${result.errors.size} model catalogs; showing cached models.`;
		this.refreshMessage = this.errorMessage ? "" : "Model catalogs refreshed.";
		this.loadModels(this.context.scopedModels);
	}

	private applyRefreshError(message: string): void {
		if (this.closed) return;
		this.errorMessage = `Could not refresh model catalogs: ${message}`;
		this.refreshMessage = "";
		this.updateList();
	}
}
