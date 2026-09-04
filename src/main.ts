import {
	App,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	PluginManifest,
	TFile,
	normalizePath,
} from 'obsidian';
import { ZoteroClient } from './api';
import { ItemPickerModal, referenceCard } from './itemPicker';
import { Mirror } from './mirror';
import { NotesEngine } from './notes';
import { EngineStatus, SyncEngine, SyncResult } from './sync';
import { ZoteroMirrorSettings, normalizeSettings } from './settings';
import { ConfirmModal, ZoteroMirrorSettingTab } from './settingsTab';
import { buildViewFiles, VIEW_MARKER } from './views';
import { fmtTime, truncate } from './util';

declare function require(id: string): any;

export default class ZoteroMirrorPlugin extends Plugin {
	settings!: ZoteroMirrorSettings;
	mirror!: Mirror;
	client!: ZoteroClient;
	engine!: SyncEngine;
	notes!: NotesEngine;

	private statusBarEl!: HTMLElement;
	private oneShots: number[] = [];
	private lastFocusSync = 0;
	private lastPollAt = 0;
	private lastTick = 0;
	private everSyncedOk = false;
	private lastErrorNotice: string | null = null;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.mirror = new Mirror(this.app.vault, () => this.settings);
		this.client = new ZoteroClient(() => this.settings);
		this.notes = new NotesEngine(this.app, this.mirror, () => this.settings);
		this.engine = new SyncEngine(this.mirror, this.client, () => this.settings, {
			onStatus: (s) => this.renderStatus(s),
			onAlert: (m, kind) => new Notice(m, kind === 'error' ? 10_000 : 5_000),
		});

		this.registerStatusBar();
		this.addRibbonIcon('refresh-cw', 'Zotero Mirror: sync now', () => {
			void this.syncFromAction(false);
		});
		this.addSettingTab(new ZoteroMirrorSettingTab(this.app, this));
		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			void this.mirror.load().then(() => {
				this.everSyncedOk = !!this.mirror.getState()?.hasData;
			});
			if (this.settings.syncOnStartup) this.schedule(() => void this.backgroundSync(false), 4000);
			// Mirror can only see Zotero changes while Obsidian is running:
			// poll every 10s and fire a sync when the configured interval elapsed.
			this.registerInterval(
				window.setInterval(() => {
					const now = Date.now();
					const cfg = this.settings.pollIntervalSeconds;
					if (cfg > 0 && now - this.lastPollAt >= cfg * 1000 && !this.engine.isBusy) {
						this.lastPollAt = now;
						void this.backgroundSync(false);
					}
				}, 10_000)
			);
		});

		if (this.settings.syncOnWindowFocus) {
			this.registerDomEvent(window, 'focus', () => {
				const now = Date.now();
				if (now - this.lastFocusSync > 10_000 && !this.engine.isBusy) {
					this.lastFocusSync = now;
					void this.backgroundSync(false);
				}
			});
		}

		this.register(() => this.oneShots.forEach((t) => window.clearTimeout(t)));
	}

	onunload(): void {
		this.statusBarEl.remove();
	}

	// ---------------------------------------------------------------- helpers

	saveSettings(): Promise<void> {
		return this.saveData(this.settings);
	}

	async resetMirror(): Promise<void> {
		new Notice('Zotero Mirror: resetting mirror…');
		await this.mirror.load();
		await this.mirror.reset();
		await this.syncFromAction(true, 'Reset complete');
	}

	/**
	 * A sync triggered by the user (ribbon, status bar, commands). Always
	 * reports back, even when nothing changed, so "it's finished" is visible.
	 */
	async syncFromAction(full: boolean, prefix?: string): Promise<void> {
		const res = await this.engine.requestSync(full);
		if (!res.ok) {
			this.notifyError(res.message);
			return;
		}
		if (!this.everSyncedOk) {
			this.everSyncedOk = true;
			if (this.settings.viewsAutoCreate) await this.safeCreateViews();
		}
		const st = this.mirror.stats();
		const when = res.hadChanges || res.reconciled ? res.message : 'Up to date';
		const head = prefix ? `${prefix} — ` : '';
		new Notice(
			`Zotero Mirror: ${head}${when}. Mirror: ${st.items} items (${st.attachments} PDFs, ${st.annotations} annotations).`,
			6000
		);
	}

	/**
	 * Automatic syncs (startup / poll / window focus). Quiet when nothing
	 * changed; announces the first completed mirror, applied changes, and
	 * errors (deduplicated so a closed Zotero doesn't spam every poll).
	 */
	private async backgroundSync(full = false): Promise<void> {
		const res = await this.engine.requestSync(full);
		if (!res.ok) {
			if (!(res.errorKind === 'unreachable' && this.everSyncedOk)) this.notifyError(res.message);
			return;
		}
		if (!this.everSyncedOk) {
			this.everSyncedOk = true;
			const st = this.mirror.stats();
			new Notice(
				`Zotero Mirror: mirror complete — ${st.items} items, ${st.attachments} PDFs, ${st.notes} notes, ${st.annotations} annotations.`,
				8000
			);
			if (this.settings.viewsAutoCreate) await this.safeCreateViews();
			return;
		}
		if (res.hadChanges) {
			new Notice(`Zotero Mirror: ${res.message}`, 5000);
		}
	}

	private async safeCreateViews(): Promise<void> {
		try {
			await this.createViews();
		} catch (e) {
			console.error('Zotero Mirror: creating Dataview views failed', e);
			new Notice(`Zotero Mirror: could not create Dataview views (${(e as Error).message})`, 8000);
		}
	}

	/**
	 * Write (or refresh) the generated Dataview dashboard notes. Files whose
	 * marker comment was deleted by the user are preserved untouched.
	 */
	async createViews(): Promise<{ created: number; preserved: number }> {
		const folder = normalizePath(this.settings.viewsFolder);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				/* already exists */
			}
		}
		const appWithPlugins = this.app as unknown as { plugins: { getPlugin(id: string): unknown } };
		const hasDataview = !!appWithPlugins.plugins?.getPlugin('dataview');
		let created = 0;
		let preserved = 0;
		for (const v of buildViewFiles(this.settings.mirrorFolder)) {
			const path = normalizePath(`${folder}/${v.name}`);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const text = await this.app.vault.cachedRead(file);
				if (!text.includes(VIEW_MARKER)) {
					preserved++;
					continue;
				}
				await this.app.vault.modify(file, v.content);
				created++;
			} else {
				await this.app.vault.create(path, v.content);
				created++;
			}
		}
		const parts = [`Zotero Mirror: Dataview views: ${created} created/refreshed`];
		if (preserved) parts.push(`${preserved} preserved (edited)`);
		parts.push(`in “${folder}”`);
		if (!hasDataview) parts.push('Dataview not installed — install it to render the views');
		new Notice(parts.join(', ') + '.', hasDataview ? 6000 : 10_000);
		return { created, preserved };
	}

	private notifyError(message: string): void {
		const text = `Zotero Mirror: ${message}`;
		if (this.lastErrorNotice === text) return;
		this.lastErrorNotice = text;
		new Notice(text, 10_000);
	}

	private schedule(fn: () => void, delayMs: number): void {
		this.oneShots.push(window.setTimeout(fn, delayMs));
	}

	// ---------------------------------------------------------------- status bar

	private registerStatusBar(): void {
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('zm-status');
		this.statusBarEl.addEventListener('click', () => {
			void this.syncFromAction(false);
		});
		this.statusBarEl.addEventListener('contextmenu', (ev: MouseEvent) => {
			ev.preventDefault();
			const menu = new Menu();
			menu.addItem((i) =>
				i.setTitle('Sync now').setIcon('refresh-cw').onClick(() => void this.syncFromAction(false))
			);
			menu.addItem((i) =>
				i
					.setTitle('Full sync & reconcile')
					.setIcon('refresh-cw')
					.onClick(() => void this.syncFromAction(true))
			);
			menu.addItem((i) =>
				i.setTitle('Search items…').setIcon('search').onClick(() => this.openItemPicker('open-note'))
			);
			menu.addItem((i) =>
				i.setTitle('Create Dataview views…').setIcon('table').onClick(() => void this.createViews())
			);
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle('Settings').setIcon('settings').onClick(() => {
					(this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.open();
					(this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.openTabById('zotero-mirror');
				})
			);
			menu.showAtMouseEvent(ev);
		});
		this.renderStatus({ phase: 'idle', message: 'Not synced yet' });
	}

	private renderStatus(s: EngineStatus): void {
		const el = this.statusBarEl;
		el.empty();
		el.removeClass('zm-offline', 'zm-error', 'zm-busy');
		const stamp = this.mirror.getState()?.lastSyncedAt;
		let text = 'Zotero';
		let cls = '';
		switch (s.phase) {
			case 'connecting':
				text = 'Zotero: connecting…';
				cls = 'zm-busy';
				break;
			case 'syncing':
			case 'reconciling':
				text = `Zotero: ${truncate(s.message, 38)}`;
				cls = 'zm-busy';
				break;
			case 'offline':
				text = 'Zotero: offline';
				cls = 'zm-offline';
				break;
			case 'error':
				text = `Zotero: ${truncate(s.message, 38)}`;
				cls = 'zm-error';
				break;
			case 'idle':
				text = stamp ? `Zotero: synced ${fmtTime(stamp)}` : 'Zotero: not synced';
				break;
		}
		const count = this.mirror.summaries().length;
		el.setText(count > 0 ? `${text} (${count})` : text);
		if (cls) el.addClass(cls);
		el.setAttribute('aria-label', s.message);
	}

	// ---------------------------------------------------------------- commands

	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: 'Sync Zotero mirror now',
			callback: () => void this.syncFromAction(false),
		});
		this.addCommand({
			id: 'full-sync',
			name: 'Full sync & reconcile mirror',
			callback: () => void this.syncFromAction(true),
		});
		this.addCommand({
			id: 'search-insert-reference',
			name: 'Search Zotero items and insert reference card',
			callback: () => this.openItemPicker('insert-reference'),
		});
		this.addCommand({
			id: 'open-item-note',
			name: 'Open generated note for a Zotero item',
			callback: () => this.openItemPicker('open-note'),
		});
		this.addCommand({
			id: 'open-item-in-zotero',
			name: 'Open a Zotero item in the Zotero app',
			callback: () => this.openItemPicker('open-in-zotero'),
		});
		this.addCommand({
			id: 'open-item-mirror-json',
			name: 'Open a Zotero item’s mirror JSON file',
			callback: () => this.openItemPicker('open-mirror-json'),
		});
		this.addCommand({
			id: 'refresh-current-note',
			name: 'Refresh note for the Zotero item in the active document',
			callback: () => void this.refreshActiveDocumentNote(),
		});
		this.addCommand({
			id: 'refresh-all-notes',
			name: 'Refresh all generated Zotero notes from the mirror',
			callback: () =>
				new ConfirmModal(
					this.app,
					'Refresh all generated notes?',
					'Existing generated notes (with markers) will be rebuilt from the mirror. Notes without markers are preserved.',
					() => void this.refreshAll(false)
				).open(),
		});
		this.addCommand({
			id: 'create-missing-notes',
			name: 'Create generated notes for every top-level item',
			callback: () =>
				new ConfirmModal(
					this.app,
					'Create notes for every item?',
					'This generates one note view per top-level item in the mirror (existing ones are refreshed). Skip child notes and attachments.',
					() => void this.refreshAll(true)
				).open(),
		});
		this.addCommand({
			id: 'create-dataview-views',
			name: 'Create/refresh Dataview views (Items, PDFs & annotations, Stats)',
			callback: () => void this.createViews(),
		});
	}

	private openItemPicker(action: 'insert-reference' | 'open-note' | 'open-in-zotero' | 'open-mirror-json'): void {
		void (async () => {
			await this.mirror.load();
			const items = this.mirror.topLevelCitable();
			if (items.length === 0) {
				new Notice('Zotero Mirror: the mirror is empty — run “Sync now” first.', 6000);
				return;
			}
			new ItemPickerModal(this.app, {
				items,
				action,
				onPick: (item) => {
					if (action === 'insert-reference') {
						const ok = ItemPickerModal.insertReferenceCard(this.app, referenceCard(item, this.settings));
						if (!ok) new Notice('Open a markdown note to insert the reference card into.');
					} else if (action === 'open-note') {
						void this.openOrCreateNote(item.key);
					} else if (action === 'open-in-zotero') {
						openExternal(`zotero://select/items/${item.key}`);
					} else if (action === 'open-mirror-json') {
						void this.openMirrorJson(item.key);
					}
				},
			}).open();
		})();
	}

	async openOrCreateNote(key: string): Promise<void> {
		const res = await this.notes.generateNote(key);
		if (res.status === 'missing') {
			new Notice(res.message, 6000);
			return;
		}
		if (res.path) {
			const f = this.app.vault.getAbstractFileByPath(normalizePath(res.path));
			if (f instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(f);
			}
		}
		if (res.status === 'preserved') new Notice(res.message, 7000);
	}

	async refreshActiveDocumentNote(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!file) {
			new Notice('Open a note that was generated from a Zotero item first.');
			return;
		}
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const key = fm?.['zotero-key'];
		if (typeof key !== 'string') {
			new Notice('The active document has no zotero-key frontmatter.', 6000);
			return;
		}
		const res = await this.notes.generateNote(key);
		if (res.status === 'missing') new Notice(res.message, 6000);
		else if (res.status === 'preserved') new Notice(res.message, 7000);
		else new Notice(`Zotero Mirror: ${res.message}`, 4000);
	}

	async refreshAll(createMissing: boolean): Promise<void> {
		new Notice('Zotero Mirror: generating notes…');
		const results = await this.notes.refreshAll(createMissing);
		let created = 0,
			refreshed = 0,
			preserved = 0,
			missing = 0;
		for (const r of results) {
			if (r.status === 'created') created++;
			else if (r.status === 'refreshed') refreshed++;
			else if (r.status === 'preserved') preserved++;
			else if (r.status === 'missing') missing++;
		}
		new Notice(`Zotero Mirror: ${created} created, ${refreshed} refreshed, ${preserved} preserved, ${missing} missing.`, 7000);
	}

	async openMirrorJson(key: string): Promise<void> {
		const path = normalizePath(`${this.settings.mirrorFolder}/items/${key}.json`);
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(f);
		} else {
			new Notice('Mirror JSON not found — sync first?');
		}
	}
}

function openExternal(url: string): void {
	try {
		const electron = require('electron');
		if (electron?.shell?.openExternal) {
			void electron.shell.openExternal(url);
			return;
		}
	} catch {
		/* fall back below */
	}
	window.open(url, '_blank');
}
