import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ZoteroMirrorPlugin from './main';
import { DEFAULT_SETTINGS, ZoteroMirrorSettings, normalizeSettings, sourceLabel } from './settings';

export class ZoteroMirrorSettingTab extends PluginSettingTab {
	private connResult = '';

	constructor(app: App, private plugin: ZoteroMirrorPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName('Zotero Mirror').setHeading();

		// ----- data source -----
		new Setting(containerEl).setName('Data source').setHeading();

		new Setting(containerEl)
			.setName('Source')
			.setDesc(
				'“Zotero desktop” talks to Zotero’s local HTTP API (localhost:23119) — offline, no API key. ' +
					'“zotero.org” syncs through the web API (needs an API key, works even when the Zotero app is closed).'
			)
			.addDropdown((dd) =>
				dd
					.addOption('local', 'Zotero desktop (local API)')
					.addOption('web', 'zotero.org (Web API)')
					.setValue(s.source)
					.onChange(async (v) => {
						this.plugin.settings.source = v as ZoteroMirrorSettings['source'];
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (s.source === 'local') {
			new Setting(containerEl)
				.setName('Local API base URL')
				.setDesc(
					'Zotero must be running with “Allow other applications on this computer to communicate with Zotero” enabled ' +
						'(Zotero → Settings → Advanced). Keep the default unless your setup differs.'
				)
				.addText((t) =>
					t
						.setPlaceholder(DEFAULT_SETTINGS.localApiUrl)
						.setValue(s.localApiUrl)
						.onChange(async (v) => {
							this.plugin.settings.localApiUrl = v.replace(/\/+$/, '') || DEFAULT_SETTINGS.localApiUrl;
							await this.plugin.saveSettings();
						})
				);
		} else {
			new Setting(containerEl)
				.setName('User ID')
				.setDesc('Numeric Zotero user id (see zotero.org/settings/keys).')
				.addText((t) =>
					t.setValue(s.webUserId).onChange(async (v) => {
						this.plugin.settings.webUserId = v.trim();
						await this.plugin.saveSettings();
					})
				);
			new Setting(containerEl)
				.setName('API key')
				.setDesc('A zotero.org API key with library read access (Settings → Keys in your zotero.org account).')
				.addText((t) => {
					t.inputEl.type = 'password';
					t.setValue(s.webApiKey).onChange(async (v) => {
						this.plugin.settings.webApiKey = v.trim();
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc(this.connResult || `Reads the source at ${sourceLabel(s)}.`)
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					b.setDisabled(true);
					b.setButtonText('Testing…');
					const ping = await this.plugin.client.ping();
					b.setDisabled(false);
					b.setButtonText('Test');
					this.connResult = ping.message;
					new Notice(ping.message, ping.ok ? 4000 : 9000);
					this.display();
				})
			);

		// ----- mirror -----
		new Setting(containerEl).setName('Mirror folder').setHeading();

		new Setting(containerEl)
			.setName('Mirror folder')
			.setDesc(
				'Vault folder holding the mirror (items/<key>.json, annotations/<key>.json, index.json, …). ' +
					'A leading dot (e.g. `.zotero`) hides it from Obsidian’s file explorer; a leading underscore (`_zotero`) keeps it visible.'
			)
			.addText((t) =>
				t.setValue(s.mirrorFolder).onChange(async (v) => {
					const next = (v.trim() || '_zotero').replace(/^\/+|\/+$/g, '');
					if (next !== s.mirrorFolder) {
						s.mirrorFolder = next;
						await this.plugin.saveSettings();
						new Notice(
							`Zotero Mirror: mirror folder changed to “${next}”. The previous folder was left in place; run “Full sync & reconcile” to build the new one.`
						);
					}
				})
			);

		new Setting(containerEl)
			.setName('Clear mirror & re-sync')
			.setDesc('Deletes all mirrored files (items/, annotations/, index, state) and pulls a full snapshot again.')
			.addButton((b) =>
				b.setButtonText('Reset mirror').setWarning().onClick(async () => {
					new ConfirmModal(this.app, 'Reset the Zotero mirror?', 'All files under the mirror folder will be deleted and rebuilt from a full sync. Generated notes are NOT touched.', async () => {
						await this.plugin.resetMirror();
					}).open();
				})
			);

		// ----- sync triggers -----
		new Setting(containerEl).setName('Sync triggers').setHeading();

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Run a sync a few seconds after Obsidian opens.')
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					s.syncOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync when the window regains focus')
			.addToggle((t) =>
				t.setValue(s.syncOnWindowFocus).onChange(async (v) => {
					s.syncOnWindowFocus = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Poll interval (seconds)')
			.setDesc('How often changes are pulled from Zotero while Obsidian is running. 0 disables polling. Zotero’s local API only serves new objects since the last sync, so this is cheap.')
			.addText((t) =>
				t
					.setValue(String(s.pollIntervalSeconds))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.pollIntervalSeconds = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.pollIntervalSeconds;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Deletion reconcile interval (minutes)')
			.setDesc(
				'Incremental syncs cannot see deletions, so the mirror periodically pulls a full snapshot and removes vanished items/annotations. 0 = only on startup and manual full syncs.'
			)
			.addText((t) =>
				t
					.setValue(String(s.reconcileMinutes))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.reconcileMinutes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.reconcileMinutes;
						await this.plugin.saveSettings();
					})
			);

		// ----- generated notes -----
		new Setting(containerEl).setName('Generated note views').setHeading();

		new Setting(containerEl)
			.setName('Notes folder')
			.setDesc('Where regenerable note views are created (outside the mirror).')
			.addText((t) =>
				t.setValue(s.noteFolder).onChange(async (v) => {
					s.noteFolder = (v.trim() || DEFAULT_SETTINGS.noteFolder).replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Custom template')
			.setDesc('Optional vault path to a markdown template. See README for tokens ({{title}}, {{#attachments}}…{{/attachments}}, …).')
			.addText((t) =>
				t.setValue(s.noteTemplatePath).onChange(async (v) => {
					s.noteTemplatePath = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Overwrite behavior')
			.setDesc('“Region only” rebuilds the text between the generated markers and preserves your edits elsewhere. “Full” replaces the whole file.')
			.addDropdown((dd) =>
				dd
					.addOption('region', 'Region only (preserve edits)')
					.addOption('full', 'Full file (destructive)')
					.setValue(s.noteOverwrite)
					.onChange(async (v) => {
						s.noteOverwrite = v as ZoteroMirrorSettings['noteOverwrite'];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Include in generated notes')
			.setDesc('Child Zotero notes, attachments and PDF annotations.')
			.addToggle((t) =>
				t
					.setValue(s.includeChildNotes)
					.setTooltip('Child notes')
					.onChange(async (v) => {
						s.includeChildNotes = v;
						await this.plugin.saveSettings();
					})
			)
			.addToggle((t) =>
				t
					.setValue(s.includeAttachments)
					.setTooltip('Attachments')
					.onChange(async (v) => {
						s.includeAttachments = v;
						await this.plugin.saveSettings();
					})
			)
			.addToggle((t) =>
				t
					.setValue(s.includeAnnotations)
					.setTooltip('Annotations')
					.onChange(async (v) => {
						s.includeAnnotations = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Annotation preview length')
			.setDesc('Truncate long highlight quotes inside generated notes (0 = keep full text).')
			.addText((t) =>
				t
					.setValue(String(s.noteAnnotationPreviewLength))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.noteAnnotationPreviewLength = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.noteAnnotationPreviewLength;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Max creators per citation')
			.addText((t) =>
				t
					.setValue(String(s.noteMaxCreators))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.noteMaxCreators = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.noteMaxCreators;
						await this.plugin.saveSettings();
					})
			);

		// ----- dataview views -----
		new Setting(containerEl).setName('Dataview views').setHeading();

		new Setting(containerEl)
			.setName('Views folder')
			.setDesc(
				'Regenerable dashboard notes containing dataviewjs queries over the mirror: items table, PDFs & annotations, library stats. Requires the Dataview community plugin to render.'
			)
			.addText((t) =>
				t.setValue(s.viewsFolder).onChange(async (v) => {
					s.viewsFolder = (v.trim() || DEFAULT_SETTINGS.viewsFolder).replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Create views automatically after the first mirror')
			.setDesc('When the mirror is first populated (or re-populated after a reset), write the three view notes.')
			.addToggle((t) =>
				t.setValue(s.viewsAutoCreate).onChange(async (v) => {
					s.viewsAutoCreate = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).addButton((b) =>
			b.setButtonText('Create / refresh views now').onClick(async () => {
				await this.plugin.createViews();
			})
		);

		new Setting(containerEl).setName('About').setHeading();
		containerEl.createEl('p', {
			text: 'Zotero Mirror keeps a git-versionable copy of your Zotero library in the vault. Everything else — search, generated notes — reads the mirror, so it works with Zotero closed. ',
			cls: 'setting-item-description',
		});
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
					.setWarning()
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
