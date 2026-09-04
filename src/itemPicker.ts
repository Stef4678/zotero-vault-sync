import { App, FuzzySuggestModal, MarkdownView } from 'obsidian';
import { ItemSummary } from './types';
import { ZoteroMirrorSettings } from './settings';
import { truncate, zoteroItemUri } from './util';

/** Build a compact Obsidian reference block for insertion into a note. */
export function referenceCard(s: ItemSummary, settings: ZoteroMirrorSettings): string {
	const mirrorRel = `${settings.mirrorFolder}/items/${s.key}.json`;
	const creatorBit = s.creators ? `**${s.creators}**` : '';
	const yearBit = s.year ? ` (${s.year})` : '';
	const title = s.title ?? `${s.itemType} ${s.key}`;
	const lines = [
		`> [!quote]- ${creatorBit}${yearBit ? ' ' + yearBit : ''}`,
		`> **${title}**`,
	];
	if (creatorBit && yearBit) lines.push(`> ${creatorBit}${yearBit}`);
	if (s.tags.length) lines.push(`> Tags: ${s.tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' ')}`);
	lines.push(
		`> \`${s.key}\` · [Zotero](zotero://select/items/${s.key}) · [[${mirrorRel}|item JSON]]`
	);
	return lines.join('\n') + '\n';
}

/** Summary line shown in the fuzzy picker. */
export function pickerText(s: ItemSummary): string {
	const who = s.creators ?? '';
	const bits: string[] = [];
	if (who) bits.push(who);
	if (s.year) bits.push(`(${s.year})`);
	const label = [bits.join(' '), s.title].filter(Boolean).join(' — ');
	const type = s.itemType === 'note' ? 'note' : s.itemType;
	return `${label}  [${type}]`;
}

export type ItemPickAction =
	| 'insert-reference'
	| 'open-note'
	| 'open-in-zotero'
	| 'open-mirror-json';

export interface ItemPickerOptions {
	items: ItemSummary[];
	action: ItemPickAction;
	placeholder?: string;
	onPick(item: ItemSummary): void;
}

/**
 * Fuzzy search over the *mirror* index (offline, no Zotero needed). The modal
 * itself never touches Zotero — results come from `_zotero/index.json`.
 */
export class ItemPickerModal extends FuzzySuggestModal<ItemSummary> {
	private opts: ItemPickerOptions;

	constructor(app: App, opts: ItemPickerOptions) {
		super(app);
		this.opts = opts;
		const hints: Record<ItemPickAction, string> = {
			'insert-reference': 'Choose an item to insert its reference card',
			'open-note': 'Choose an item to open (or generate) its note view',
			'open-in-zotero': 'Choose an item to open in Zotero',
			'open-mirror-json': 'Choose an item to open its mirror JSON',
		};
		this.setPlaceholder(hints[opts.action] ?? 'Search Zotero items…');
		this.limit = 60;
	}

	onOpen(): void {
		super.onOpen();
		this.titleEl.setText('Zotero items (mirror)');
	}

	getItems(): ItemSummary[] {
		// searchable, non-annotation items only; children are noise when searching
		return this.opts.items.filter((s) => !(s.itemType === 'annotation'));
	}

	getItemText(item: ItemSummary): string {
		return `${pickerText(item)} ${(item.tags ?? []).join(' ')} ${item.collections.join(' ')}`.toLowerCase();
	}

	onChooseItem(item: ItemSummary, _evt: MouseEvent | KeyboardEvent): void {
		this.opts.onPick(item);
	}

	/** Insert the reference card at the cursor of the active markdown editor. */
	static insertReferenceCard(app: App, card: string): boolean {
		const view = app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return false;
		const editor = view.editor;
		editor.replaceSelection(`\n${card}\n`);
		return true;
	}
}

/** Short label with type tag, used in picker rows. */
export function itemSummaryLabel(s: ItemSummary, maxTitle = 100): string {
	const creatorBit = s.creators ? `${truncate(s.creators, 60)} — ` : '';
	const title = s.title ? truncate(s.title, maxTitle) : s.key;
	return `${creatorBit}${title}`;
}

export { zoteroItemUri };
