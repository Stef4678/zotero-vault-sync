import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type ZoteroMirrorPlugin from './main';
import { DEFAULT_SETTINGS, normalizeSettings, sourceLabel } from './settings';

/** Folder settings: trimmed, without surrounding slashes, falling back to the default. */
const FOLDER_FALLBACKS: Record<string, string> = {
	mirrorFolder: DEFAULT_SETTINGS.mirrorFolder,
	noteFolder: DEFAULT_SETTINGS.noteFolder,
	viewsFolder: DEFAULT_SETTINGS.viewsFolder,
};

const TRIMMED_KEYS = ['webUserId', 'webApiKey', 'noteTemplatePath'];

export class ZoteroMirrorSettingTab extends PluginSettingTab {
	private connResult = '';

	constructor(app: App, private plugin: ZoteroMirrorPlugin) {
		super(app, plugin);
	}

	/**
	 * Normalize a value before it is written to `plugin.settings`. The declarative
	 * bindings write raw input, so a half-typed folder would otherwise reach the
	 * mirror as-is until the next reload (`normalizeSettings` only runs on load).
	 */
	private normalizeValue(key: string, value: unknown): unknown {
		if (typeof value !== 'string') return value;
		if (key === 'localApiUrl') return value.replace(/\/+$/, '') || DEFAULT_SETTINGS.localApiUrl;
		if (key in FOLDER_FALLBACKS) {
			const folder = value.trim().replace(/^\/+|\/+$/g, '');
			return folder || FOLDER_FALLBACKS[key];
		}
		if (TRIMMED_KEYS.includes(key)) return value.trim();
		return value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const mirrorBefore = this.plugin.settings.mirrorFolder;
		await super.setControlValue(key, this.normalizeValue(key, value));
		// Obsidian re-evaluates predicates after a control change; be explicit for
		// the one that gates the local/web rows so they can't go stale.
		if (key === 'source') this.refreshDomState();
		if (key === 'mirrorFolder' && this.plugin.settings.mirrorFolder !== mirrorBefore) {
			new Notice(
				`Zotero Vault Sync: mirror folder changed to “${this.plugin.settings.mirrorFolder}”. ` +
					'The previous folder was left in place; run “Full sync & reconcile” to build the new one.'
			);
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const isLocal = (): boolean => this.plugin.settings.source === 'local';
		const isWeb = (): boolean => this.plugin.settings.source === 'web';

		return [
			{
				type: 'group',
				heading: 'Data source',
				items: [
					{
						name: 'Source',
						desc:
							'“Zotero desktop” talks to Zotero’s local HTTP API (localhost:23119) — offline, no API key. ' +
							'“zotero.org” syncs through the web API (needs an API key, works even when the Zotero app is closed).',
						control: {
							type: 'dropdown',
							key: 'source',
							options: {
								local: 'Zotero desktop (local API)',
								web: 'zotero.org (Web API)',
							},
						},
					},
					{
						name: 'Local API base URL',
						desc:
							'Zotero must be running with “Allow other applications on this computer to communicate with Zotero” enabled ' +
							'(Zotero → Settings → Advanced). Keep the default unless your setup differs.',
						visible: isLocal,
						control: { type: 'text', key: 'localApiUrl', placeholder: DEFAULT_SETTINGS.localApiUrl },
					},
					{
						name: 'User ID',
						desc: 'Numeric Zotero user id (see zotero.org/settings/keys).',
						visible: isWeb,
						control: { type: 'text', key: 'webUserId' },
					},
					{
						name: 'API key',
						desc: 'A zotero.org API key with library read access (Settings → Keys in your zotero.org account).',
						visible: isWeb,
						render: (setting) => {
							// No declarative control masks input, so build the row by hand
							// and persist explicitly (render callbacks don't auto-save).
							setting.addText((t) => {
								t.inputEl.type = 'password';
								t.setValue(this.plugin.settings.webApiKey).onChange(async (v) => {
									this.plugin.settings.webApiKey = v.trim();
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: 'Test connection',
						desc: this.connResult || `Reads the source at ${sourceLabel(s)}.`,
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText('Test').onClick(async () => {
									b.setDisabled(true);
									b.setButtonText('Testing…');
									const ping = await this.plugin.client.ping();
									b.setDisabled(false);
									b.setButtonText('Test');
									this.connResult = ping.message;
									new Notice(ping.message, ping.ok ? 4000 : 9000);
									// Rebuilds the definitions so the result shows in `desc`.
									this.update();
								})
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Mirror',
				items: [
					{
						name: 'Mirror folder',
						desc:
							'Vault folder holding the mirror (items/<key>.json, annotations/<key>.json, index.json, …). ' +
							'A leading dot (e.g. `.zotero`) hides it from Obsidian’s file explorer; a leading underscore (`_zotero`) keeps it visible.',
						control: { type: 'text', key: 'mirrorFolder' },
					},
					{
						name: 'Clear mirror & re-sync',
						desc: 'Deletes all mirrored files (items/, annotations/, index, state) and pulls a full snapshot again.',
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText('Reset mirror').setDestructive().onClick(() => {
									new ConfirmModal(
										this.app,
										'Reset the Zotero mirror?',
										'All files under the mirror folder will be deleted and rebuilt from a full sync. Generated notes are NOT touched.',
										async () => {
											await this.plugin.resetMirror();
										}
									).open();
								})
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Sync triggers',
				items: [
					{
						name: 'Sync on startup',
						desc: 'Run a sync a few seconds after Obsidian opens.',
						control: { type: 'toggle', key: 'syncOnStartup' },
					},
					{
						name: 'Sync when the window regains focus',
						desc: 'Pull changes as soon as you come back to Obsidian.',
						control: { type: 'toggle', key: 'syncOnWindowFocus' },
					},
					{
						name: 'Poll interval (seconds)',
						desc:
							'How often changes are pulled from Zotero while Obsidian is running. 0 disables polling. Zotero’s local API only serves new objects since the last sync, so this is cheap.',
						control: { type: 'number', key: 'pollIntervalSeconds', min: 0, defaultValue: DEFAULT_SETTINGS.pollIntervalSeconds },
					},
					{
						name: 'Deletion reconcile interval (minutes)',
						desc:
							'Incremental syncs cannot see deletions, so the mirror periodically pulls a full snapshot and removes vanished items/annotations. 0 = only on startup and manual full syncs.',
						control: { type: 'number', key: 'reconcileMinutes', min: 0, defaultValue: DEFAULT_SETTINGS.reconcileMinutes },
					},
				],
			},
			{
				type: 'group',
				heading: 'Generated note views',
				items: [
					{
						name: 'Notes folder',
						desc: 'Where regenerable note views are created (outside the mirror).',
						control: { type: 'text', key: 'noteFolder' },
					},
					{
						name: 'Custom template',
						desc: 'Optional vault path to a markdown template. See README for tokens ({{title}}, {{#attachments}}…{{/attachments}}, …).',
						control: { type: 'text', key: 'noteTemplatePath' },
					},
					{
						name: 'Overwrite behavior',
						desc: '“Region only” rebuilds the text between the generated markers and preserves your edits elsewhere. “Full” replaces the whole file.',
						control: {
							type: 'dropdown',
							key: 'noteOverwrite',
							options: {
								region: 'Region only (preserve edits)',
								full: 'Full file (destructive)',
							},
						},
					},
					{
						name: 'Include child notes',
						desc: 'Quote the Zotero notes attached to an item into its generated note.',
						control: { type: 'toggle', key: 'includeChildNotes' },
					},
					{
						name: 'Include attachments',
						desc: 'One section per attachment (PDF) in the generated note.',
						control: { type: 'toggle', key: 'includeAttachments' },
					},
					{
						name: 'Include PDF annotations',
						desc: 'List highlights and comments inside each attachment section. Has no effect while “Include attachments” is off.',
						control: { type: 'toggle', key: 'includeAnnotations' },
					},
					{
						name: 'Annotation preview length',
						desc: 'Truncate long highlight quotes inside generated notes (0 = keep full text).',
						control: {
							type: 'number',
							key: 'noteAnnotationPreviewLength',
							min: 0,
							defaultValue: DEFAULT_SETTINGS.noteAnnotationPreviewLength,
						},
					},
					{
						name: 'Max creators per citation',
						desc: 'Authors listed before “et al.” in the generated citation.',
						control: { type: 'number', key: 'noteMaxCreators', min: 1, defaultValue: DEFAULT_SETTINGS.noteMaxCreators },
					},
				],
			},
			{
				type: 'group',
				heading: 'Dataview views',
				items: [
					{
						name: 'Views folder',
						desc:
							'Regenerable dashboard notes containing dataviewjs queries over the mirror: items table, PDFs & annotations, library stats. Requires the Dataview community plugin to render.',
						control: { type: 'text', key: 'viewsFolder' },
					},
					{
						name: 'Create views automatically after the first mirror',
						desc: 'When the mirror is first populated (or re-populated after a reset), write the three view notes.',
						control: { type: 'toggle', key: 'viewsAutoCreate' },
					},
					{
						name: 'Create or refresh views now',
						desc: 'Write the three Dataview dashboard notes into the views folder.',
						action: () => {
							void this.plugin.createViews();
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'About',
				items: [
					{
						name: 'Zotero Vault Sync',
						desc:
							'Keeps a git-versionable copy of your Zotero library in the vault. Everything else — search, generated notes — reads the mirror, so it works with Zotero closed.',
					},
				],
			},
		];
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText('Cancel').onClick(() => {
					this.close();
				})
			)
			.addButton((b) =>
				b
					.setButtonText('Confirm')
					.setDestructive()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export { normalizeSettings };
