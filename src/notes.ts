import { App, TFile, normalizePath } from 'obsidian';
import { Mirror } from './mirror';
import { ZoteroMirrorSettings } from './settings';
import { renderTemplate, TemplateElement, mdCell } from './template';
import { ItemSummary, ZoteroItem, ZoteroItemData } from './types';
import {
	creatorName,
	creatorNameList,
	creatorsText,
	htmlToText,
	isoNow,
	itemDisplayTitle,
	sanitizeFilename,
	truncate,
	yearFromDate,
} from './util';

export const MARK_START = '<!-- zotero-mirror:start -->';
export const MARK_END = '<!-- zotero-mirror:end -->';
const OWNER_FIELD = 'zotero-mirror';

export interface GenerateNoteResult {
	status: 'created' | 'refreshed' | 'preserved' | 'missing';
	path?: string;
	message: string;
}

interface ManagedFrontmatter {
	zoteroKey: string;
	mirror: boolean;
	itemType: string;
	title: string;
	updated: string;
	tags: string[];
}

const MANAGED_KEYS = ['zotero-key', OWNER_FIELD, 'zotero-item-type', 'title', 'updated', 'tags'];

function yamlQuote(s: string): string {
	return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** Body (no opening/closing `---`) of the managed frontmatter. */
function managedBodyLines(m: ManagedFrontmatter): string[] {
	const lines: string[] = [];
	lines.push(`zotero-key: ${yamlQuote(m.zoteroKey)}`);
	lines.push(`${OWNER_FIELD}: true`);
	lines.push(`zotero-item-type: ${yamlQuote(m.itemType)}`);
	lines.push(`title: ${yamlQuote(m.title)}`);
	lines.push(`updated: ${yamlQuote(m.updated)}`);
	if (m.tags.length) {
		lines.push('tags:');
		for (const t of m.tags) lines.push(`  - ${yamlQuote(t)}`);
	} else {
		lines.push('tags: []');
	}
	return lines;
}

function freshFileText(managed: ManagedFrontmatter, body: string): string {
	const block = ['---', ...managedBodyLines(managed), '---'].join('\n');
	return `${block}\n\n${MARK_START}\n${body}\n${MARK_END}\n`;
}

interface FmRegion {
	has: boolean;
	innerStart: number;
	bodyStart: number;
}

/** Locate a `---` delimited YAML frontmatter block starting at offset 0. */
function locateFrontmatter(md: string): FmRegion {
	if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) {
		return { has: false, innerStart: 0, bodyStart: 0 };
	}
	const nlLen = md.startsWith('---\r\n') ? 2 : 1; // length of the newline sequence
	const innerStart = 3 + nlLen;
	let i = innerStart;
	for (;;) {
		const eol = md.indexOf('\n', i);
		const lineEnd = eol === -1 ? md.length : eol;
		let line = md.slice(i, lineEnd);
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line === '---') {
			return { has: true, innerStart, bodyStart: eol === -1 ? md.length : eol + 1 };
		}
		if (eol === -1) break;
		i = eol + 1;
	}
	// frontmatter never closed — treat as plain markdown so nothing is lost
	return { has: false, innerStart: 0, bodyStart: 0 };
}

/**
 * Rewrite only the keys this plugin manages, preserving every other YAML key
 * (and all body text). No YAML parser dependency: we drop existing lines of
 * the managed keys (plus their indented continuations) and reinsert our own
 * block at the top of the frontmatter.
 */
export function patchFrontmatter(md: string, managed: ManagedFrontmatter): string {
	const region = locateFrontmatter(md);
	const body = region.has ? md.slice(region.bodyStart) : md;

	if (!region.has) {
		const block = ['---', ...managedBodyLines(managed), '---'].join('\n');
		return `${block}\n${body.startsWith('\n') ? body : '\n' + body}`;
	}

	const inner = md.slice(region.innerStart, region.bodyStart - 1);
	const kept: string[] = [];
	const lines = inner.split(/\r?\n/);
	let droppingManaged = false;
	for (const line of lines) {
		if (line === '---' || line.trim() === '') continue;
		const keyMatch = /^([A-Za-z0-9_-]+):\s*/.exec(line);
		if (keyMatch) {
			droppingManaged = MANAGED_KEYS.includes(keyMatch[1]);
			if (droppingManaged) continue;
		} else if (droppingManaged) {
			if (/^\s+/.test(line)) continue; // indented continuation of managed key
			droppingManaged = false;
		}
		kept.push(line);
	}
	const block = ['---', ...managedBodyLines(managed), ...kept, '---'].join('\n');
	return `${block}\n${body.startsWith('\n') ? body : '\n' + body}`;
}

function itemTypeLabel(itemType: string): string {
	if (!itemType) return 'Item';
	return itemType
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/^\w/, (c) => c.toUpperCase());
}

/** First non-empty line of an HTML note, used as display title. */
function noteTitle(data: ZoteroItemData): string {
	const txt = htmlToText(data.note);
	const first = txt.split('\n').find((l) => l.trim().length > 0);
	return first ? truncate(first.trim(), 80) : 'Note';
}

/** Naive offline citation (APA-ish). Regenerable without Zotero running. */
export function naiveCitation(record: ZoteroItem, summary: ItemSummary | undefined, settings: ZoteroMirrorSettings): string {
	const d = record.data;
	const creators = (d.creators ?? []).map((c) => {
		const n = creatorName(c);
		const m = /^(.+),\s*(.+)$/.exec(n);
		return m ? `${m[2]} ${m[1]}` : n;
	});
	const max = settings.noteMaxCreators || 6;
	const head = creators.length ? creators.slice(0, max).join(', ') + (creators.length > max ? ' et al.' : '') : '';
	const year = yearFromDate(d.date) || (summary?.year ?? '');
	const title = (itemDisplayTitle(d) || d.title || '').trim();
	const pub = d.publicationTitle || d.bookTitle || d.proceedingsTitle || '';
	const bits: string[] = [];
	if (head) bits.push(head);
	if (year) bits.push(`(${year})`);
	if (title) bits.push(`*${title}*`);
	if (pub) bits.push(pub);
	if (d.volume) bits.push(d.volume);
	if (d.issue) bits.push(`(${d.issue})`);
	if (d.pages) bits.push(d.pages);
	let cite = bits.filter(Boolean).join('. ').replace(/\.\./g, '.') + '.';
	const ref = d.DOI ? ` https://doi.org/${d.DOI}` : d.url ? ` ${d.url}` : '';
	if (ref) cite += ref;
	return cite;
}

const DEFAULT_TEMPLATE = `# {{title}}

> [!info]- Item
> {{#creatorList}}**{{creatorList}}** · {{/creatorList}}{{itemTypeLabel}}{{#publicationTitle}}, *{{publicationTitle}}*{{/publicationTitle}}{{#date}}, {{date}}{{/date}}
> {{#doi}}DOI: [{{doi}}](https://doi.org/{{doi}}){{/doi}}{{#url}} · [Link]({{url}}){{/url}}
> Collections: {{collections}} · Tags: {{tags}}
> [Open in Zotero]({{zoteroLink}}) · {{mirrorLink}}

{{#abstract}}
**Abstract.** {{abstract}}
{{/abstract}}

## Metadata

| Field | Value |
| --- | --- |
{{#metaRows}}| {{field}} | {{value}} |{{/metaRows}}

{{?childNotes}}
## Notes (from Zotero)

{{#childNotes}}> {{content}}

{{/childNotes}}
{{/childNotes}}

{{?attachments}}
## Attachments & annotations

{{#attachments}}### {{filename}}

{{#annotations}}> {{colorEmoji}} **{{colorName}}**{{#pageLabel}} (p. {{pageLabel}}){{/pageLabel}}: “{{text}}”{{#comment}} — {{comment}}{{/comment}}

{{/annotations}}
{{#annotationsEmpty}}_No annotations._{{/annotationsEmpty}}

{{/attachments}}
{{/attachments}}

---

*Generated by **Zotero Mirror** from the vault mirror — regenerable any time. Only the text between the markers is rebuilt; edit everything else freely.*
`;

const COLOR_NAME: Record<string, string> = {
	'#ffd400': 'Yellow',
	'#ff6666': 'Red',
	'#5fb236': 'Green',
	'#2ea8e5': 'Blue',
	'#a28ae5': 'Purple',
	'#ff66b2': 'Magenta',
};
const COLOR_EMOJI: Record<string, string> = {
	'#ffd400': '🟨',
	'#ff6666': '🟥',
	'#5fb236': '🟩',
	'#2ea8e5': '🟦',
	'#a28ae5': '🟪',
	'#ff66b2': '🟪',
};

function colorLabel(hex: string | null | undefined): string {
	if (!hex) return 'Highlight';
	const k = hex.toLowerCase();
	if (COLOR_NAME[k]) return COLOR_NAME[k];
	const m = /^#?([0-9a-f]{3})$/.exec(k);
	if (m) {
		const full = '#' + m[1].split('').map((c) => c + c).join('');
		if (COLOR_NAME[full]) return COLOR_NAME[full];
	}
	return hex;
}

function colorEmoji(hex: string | null | undefined): string {
	if (!hex) return '🔆';
	const k = hex.toLowerCase();
	if (COLOR_EMOJI[k]) return COLOR_EMOJI[k];
	const m = /^#?([0-9a-f]{3})$/.exec(k);
	if (m) {
		const full = '#' + m[1].split('').map((c) => c + c).join('');
		if (COLOR_EMOJI[full]) return COLOR_EMOJI[full];
	}
	return '🔆';
}

/**
 * Generated note "views". Notes are pure views over the mirror: every render
 * reads only `_zotero/items`, never Zotero, so they work with Zotero closed
 * and are safe to regenerate after any sync.
 */
export class NotesEngine {
	constructor(
		private app: App,
		private mirror: Mirror,
		private getSettings: () => ZoteroMirrorSettings
	) {}

	/** Create or refresh the generated note for one Zotero item key. */
	async generateNote(key: string): Promise<GenerateNoteResult> {
		const settings = this.getSettings();
		await this.mirror.load();
		const summary = this.mirror.summary(key);
		const record = await this.mirror.fullRecord(key);
		if (!summary || !record) {
			return { status: 'missing', message: `Item ${key} is not in the mirror — sync first?` };
		}

		const target = await this.resolveTarget(key, summary, record);
		const body = await this.renderBody(summary, record);
		const managed = this.managedFor(summary, record);

		if (target.path == null) {
			// ---- create ----
			const folder = normalizePath(settings.noteFolder);
			if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFile)) {
				try {
					await this.app.vault.createFolder(folder);
				} catch {
					/* already exists */
				}
			}
			let finalPath = normalizePath(`${folder}/${target.base}.md`);
			if (await this.app.vault.adapter.exists(finalPath)) {
				finalPath = normalizePath(`${folder}/${target.base} (${key}).md`);
			}
			await this.app.vault.create(finalPath, freshFileText(managed, body));
			this.mirror.setNotePath(key, finalPath);
			return { status: 'created', path: finalPath, message: `Created ${finalPath}` };
		}

		// ---- refresh existing file ----
		const existing = target.existingText ?? '';
		const owned = existing.slice(0, 400).includes(`${OWNER_FIELD}: true`);
		const i0 = existing.indexOf(MARK_START);
		const i1 = existing.indexOf(MARK_END);

		if (i0 >= 0 && i1 > i0) {
			// region mode: rebuild only the marked region; keep user text around it
			let patched = patchFrontmatter(existing, managed);
			const j0 = patched.indexOf(MARK_START);
			const j1 = patched.indexOf(MARK_END);
			if (j0 >= 0 && j1 > j0) {
				patched =
					patched.slice(0, j0 + MARK_START.length) +
					`\n${body}\n` +
					patched.slice(j1);
			}
			await this.writeFile(target.path, patched);
			this.mirror.setNotePath(key, target.path);
			return { status: 'refreshed', path: target.path, message: `Refreshed ${target.path}` };
		}

		if (settings.noteOverwrite === 'full' && owned) {
			await this.writeFile(target.path, freshFileText(managed, body));
			this.mirror.setNotePath(key, target.path);
			return { status: 'refreshed', path: target.path, message: `Regenerated ${target.path}` };
		}

		if (owned) {
			return {
				status: 'preserved',
				path: target.path,
				message: `${target.path} has no generated markers — left untouched. Enable overwrite mode "full" in settings to replace it.`,
			};
		}
		return { status: 'preserved', path: target.path, message: `${target.path} is not a generated note — skipped.` };
	}

	/** Regenerate existing generated notes for every top-level item (optionally create missing ones). */
	async refreshAll(createMissing: boolean): Promise<GenerateNoteResult[]> {
		await this.mirror.load();
		const out: GenerateNoteResult[] = [];
		for (const s of this.mirror.topLevelCitable()) {
			const reg = this.mirror.notePathFor(s.key);
			if (!reg && !createMissing) continue;
			out.push(await this.generateNote(s.key));
		}
		return out;
	}

	private async renderBody(summary: ItemSummary, record: ZoteroItem): Promise<string> {
		const settings = this.getSettings();
		const d = record.data ?? ({} as ZoteroItemData);
		const children = await this.mirror.childRecords(summary.key);

		const date = d.date || record.meta?.parsedDate || '';
		const creatorList = creatorNameList(d.creators) ?? '';
		const maxC = settings.noteMaxCreators || 6;
		const creatorsShort = (() => {
			if (!creatorList) return '';
			const parts = creatorList.split(', ');
			return parts.length > maxC ? parts.slice(0, maxC).join(', ') + ' et al.' : creatorList;
		})();
		const collections = (d.collections ?? [])
			.map((k) => this.mirror.collectionName(k) ?? k)
			.filter(Boolean)
			.join(', ');
		const tags = (d.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.tag ?? '')).filter(Boolean);

		const mirrorJsonRel = `${this.getSettings().mirrorFolder}/items/${summary.key}.json`;
		const rootTokens: Record<string, string> = {
			key: summary.key,
			title: this.displayTitle(summary, record),
			creators: creatorsText(d.creators) ?? '',
			creatorList,
			creatorsShort,
			year: summary.year ?? '',
			date,
			itemTypeLabel: itemTypeLabel(d.itemType),
			publicationTitle: d.publicationTitle || d.bookTitle || d.proceedingsTitle || '',
			abstract: htmlToText(d.abstractNote),
			doi: d.DOI ?? '',
			url: d.url ?? '',
			collections,
			tags: tags.join(', '),
			zoteroLink: `[${summary.key}](zotero://select/items/${summary.key})`,
			mirrorLink: `[[${mirrorJsonRel}|item JSON]]`,
			citation: naiveCitation(record, summary, settings),
		};

		const metaRows: TemplateElement[] = [];
		const addMeta = (field: string, value: unknown) => {
			if (value == null || String(value).trim() === '') return;
			metaRows.push({ tokens: { field: mdCell(field), value: mdCell(String(value)) } });
		};
		addMeta('Publication', d.publicationTitle || d.bookTitle || d.proceedingsTitle);
		addMeta('Volume', d.volume);
		addMeta('Issue', d.issue);
		addMeta('Pages', d.pages);
		addMeta('Publisher', d.publisher);
		addMeta('Place', d.place);
		addMeta('Series', d.series);
		addMeta('Edition', d.edition);
		addMeta('Date', date);
		addMeta('DOI', d.DOI);
		addMeta('URL', d.url);
		addMeta('ISBN', d.ISBN);
		addMeta('ISSN', d.ISSN);
		addMeta('Language', d.language);
		addMeta('Call number', d.callNumber);
		addMeta('Archive', d.archive);
		addMeta('Accessed', d.accessDate);

		const childNotes: TemplateElement[] = [];
		const attachments: TemplateElement[] = [];
		for (const child of children) {
			const cdata = child.item.data ?? ({} as ZoteroItemData);
			if (cdata.itemType === 'note' && settings.includeChildNotes) {
				childNotes.push({ tokens: { content: truncate(htmlToText(cdata.note), 3000) } });
			} else if (cdata.itemType === 'attachment' && settings.includeAttachments) {
				const annChildren = (await this.mirror.childRecords(child.item.key)).filter(
					(c) => c.item.data.itemType === 'annotation'
				);
				const annotations: TemplateElement[] = [];
				for (const a of annChildren) {
					const ad = a.item.data;
					annotations.push({
						tokens: {
							colorEmoji: colorEmoji(ad.annotationColor),
							colorName: colorLabel(ad.annotationColor),
							pageLabel: ad.annotationPageLabel ?? '',
							text: truncate(ad.annotationText ?? '', settings.noteAnnotationPreviewLength),
							comment: ad.annotationComment ?? '',
						},
					});
				}
				attachments.push({
					tokens: {
						filename: cdata.filename || cdata.title || child.item.key,
						contentType: cdata.contentType || 'file',
						attachmentLink: `zotero://select/items/${child.item.key}`,
					},
					lists: {
						annotations,
						annotationsEmpty: annotations.length ? [] : [{ tokens: {} }],
					},
				});
			}
		}

		const scope = {
			tokens: rootTokens,
			lists: { metaRows, childNotes, attachments },
		};

		let template = DEFAULT_TEMPLATE;
		const custom = this.getSettings().noteTemplatePath.trim();
		if (custom) {
			const f = this.app.vault.getAbstractFileByPath(normalizePath(custom));
			if (f instanceof TFile) template = await this.app.vault.cachedRead(f);
		}
		return renderTemplate(template, scope).replace(/\n{3,}/g, '\n\n').trim();
	}

	private displayTitle(summary: ItemSummary, record: ZoteroItem): string {
		const d = record.data ?? ({} as ZoteroItemData);
		if (summary.title) return summary.title;
		if (d.itemType === 'note') return noteTitle(d);
		return summary.itemType === 'attachment' ? 'Attachment' : creatorsText(d.creators) ?? summary.key;
	}

	private managedFor(summary: ItemSummary, record: ZoteroItem): ManagedFrontmatter {
		const d = record.data ?? ({} as ZoteroItemData);
		const tags = (d.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.tag ?? '')).filter(Boolean);
		return {
			zoteroKey: summary.key,
			mirror: true,
			itemType: d.itemType ?? 'unknown',
			title: this.displayTitle(summary, record),
			updated: isoNow(),
			tags,
		};
	}

	private async resolveTarget(
		key: string,
		summary: ItemSummary,
		record: ZoteroItem
	): Promise<{ path: string | null; base?: string; existingText?: string }> {
		// 1) registry path (fast)
		const registered = this.mirror.notePathFor(key);
		if (registered) {
			const norm = normalizePath(registered);
			const text = await this.readIfExists(norm);
			if (text != null) return { path: norm, existingText: text };
		}
		// 2) frontmatter scan — the user may have moved/renamed the note
		const byFm = await this.findByKey(key);
		if (byFm) {
			const text = await this.readIfExists(byFm);
			if (text != null) return { path: byFm, existingText: text };
		}
		// 3) brand new file in the note folder
		const d = record.data ?? ({} as ZoteroItemData);
		const title = summary.title ?? (d.itemType === 'note' ? noteTitle(d) : '');
		const who = creatorsText(d.creators) ? sanitizeFilename(creatorsText(d.creators)!.split(';')[0].trim(), 50) : '';
		const year = summary.year ?? yearFromDate(d.date) ?? '';
		const base = title
			? [who, year ? `(${year})` : '', sanitizeFilename(title, 90)].filter(Boolean).join(' ')
			: `${itemTypeLabel(d.itemType) || 'Item'} ${summary.key}`;
		return { path: null, base };
	}

	private async findByKey(key: string): Promise<string | null> {
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm?.['zotero-key'] === key) return f.path;
		}
		return null;
	}

	private async readIfExists(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		try {
			return await this.app.vault.cachedRead(file);
		} catch {
			return null;
		}
	}

	private async writeFile(path: string, content: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
	}
}
