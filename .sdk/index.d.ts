// MINIMAL STUB covering only what this plugin uses, written from the real
// API reference (docs/plugin-api/*.md) in the upstream LearnHarness repo at
// the commit this was developed against. This is NOT the real SDK package —
// swap in the real `.sdk/` (via `npm run sdk` in a LearnHarness checkout, or
// the downloaded authoring skill's types/) before a final build.

export interface AgentTool<T = unknown> {
	name: string;
	description: string;
	parameters: unknown;
	execute(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export interface PluginToolContext {
	chatId: string;
	agent: "teacher" | "prober" | "practice";
}

export type PluginAgentKind = "teacher" | "prober" | "practice";

export interface PluginTools {
	agents: PluginAgentKind[];
	create(context: PluginToolContext): AgentTool<any>[];
}

export interface PluginCleanup {
	(): void | Promise<void>;
}

export interface PluginSettingsRowBase<T> {
	key: string;
	label: string;
	value: T;
	onChange(value: T): void | Promise<void>;
	description?: string;
	disabled?: boolean;
	validate?(value: T): string | undefined;
}

export type PluginSettingsRow =
	| (PluginSettingsRowBase<boolean> & { type: "toggle" })
	| (PluginSettingsRowBase<string> & { type: "text" })
	| (PluginSettingsRowBase<string> & { type: "dropdown"; options: { value: string; label: string }[] })
	| (PluginSettingsRowBase<number> & { type: "number" | "slider"; min?: number; max?: number; step?: number });

export interface PluginWidgetHandle<_S> {
	dispose?(): void;
}

export interface PluginSettingsRegistration {
	rows: PluginSettingsRow[];
}

export interface PluginBackendContext {
	readonly manifest: { id: string; version: string };
	readonly directory: string;
	readonly dataDirectory: string;
	readonly signal: AbortSignal;
	cleanup(fn: PluginCleanup): void;
	registerTools(contribution: PluginTools): () => void;
	handle(name: string, handler: (input: unknown) => unknown | Promise<unknown>): () => void;
	events: {
		on(listener: (event: unknown) => void): () => void;
		emit(topic: string, data?: unknown): void;
	};
	registerSettings?(settings: PluginSettingsRegistration): PluginWidgetHandle<PluginSettingsRegistration> | (() => void);
}

export interface PluginView {
	id: string;
	name: string;
	mount(container: HTMLElement, signal: AbortSignal): void | PluginCleanup | Promise<void | PluginCleanup>;
}

export interface PluginFrontendContext {
	readonly manifest?: { id: string; version: string };
	readonly signal?: AbortSignal;
	cleanup?(fn: PluginCleanup): void;
	registerView(view: PluginView): () => void;
	registerSettings?(settings: PluginSettingsRegistration): PluginWidgetHandle<PluginSettingsRegistration> | (() => void);
	call<T = unknown>(operation: string, input?: unknown): Promise<T>;
}
