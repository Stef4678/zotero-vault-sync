import type { ItemSummary, ZoteroCreator, ZoteroItem, ZoteroItemData } from './types';

/** normalizePath is re-exported here so non-UI modules can stay obsidian-free-ish. */

export function clampInt(v: unknown, def: number, min: number, max: number): number {
	const n = typeof v === 'number' ? v : parseInt(String(v), 10);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, Math.round(n)));
}

export function isTruthySetting(v: unknown): boolean {
	return v === true || v === 1 || v === '1' || v === 'true';
}

/** Strip HTML tags but keep newlines/paragraph breaks readable. */
export function htmlToText(html: string | null | undefined): string {
	if (!html) return '';
	return html
		.replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li[^>]*>/gi, '- ')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Zotero creator to a single display string. */
export function creatorName(c: ZoteroCreator): string {
	if (c.name) return c.name;
	const parts = [c.lastName, c.firstName].filter((p): p is string => !!p && p.length > 0);
	if (parts.length) return parts.join(', ');
	return 'Unknown';
}

/** creators[] -> "Doe, John; Smith, A." ; null when empty */
export function creatorsText(creators: ZoteroCreator[] | undefined): string | null {
	if (!creators || creators.length === 0) return null;
	return creators.map(creatorName).join('; ');
}

export function creatorNameList(creators: ZoteroCreator[] | undefined): string | null {
	if (!creators || creators.length === 0) return null;
	return creators.map((c) => {
		const n = creatorName(c);
		// "Last, First" -> "First Last" for reading order
		const m = /^(.+),\s*(.+)$/.exec(n);
		return m ? `${m[2]} ${m[1]}` : n;
	}).join(', ');
}

/** Best 4-digit year from a Zotero date field. */
export function yearFromDate(date: string | null | undefined): string | null {
	if (!date) return null;
	const m = /(\d{4})/.exec(date);
	return m ? m[1] : null;
}

export function itemDisplayTitle(data: ZoteroItemData): string | null {
	if (data.itemType === 'attachment') {
		return data.filename || data.title || null;
	}
	if (data.itemType === 'note' || data.itemType === 'annotation') {
		return null;
	}
	return data.title || null;
}

export function itemDate(data: ZoteroItemData): string | null {
	return data.date || data.dateAdded || null;
}

/** Build the index summary for an API item record. */
export function summarizeItem(item: ZoteroItem): ItemSummary {
	const d = item.data ?? ({} as ZoteroItemData);
	return {
		key: item.key,
		version: item.version,
		itemType: d.itemType || 'unknown',
		title: itemDisplayTitle(d),
		creators: creatorsText(d.creators),
		year: yearFromDate(d.date),
		date: itemDate(d),
		parentItem: d.parentItem || null,
		collections: Array.isArray(d.collections) ? d.collections : [],
		tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => (typeof t === 'string' ? t : t?.tag ?? '')).filter(Boolean),
	};
}

/** Sanitize a string so it is safe as an Obsidian file/folder name. */
export function sanitizeFilename(name: string, maxLen = 120): string {
	let out = name
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	out = out.replace(/\.+$/g, '');
	if (out.length > maxLen) out = out.slice(0, maxLen).trim() + '…';
	out = out.replace(/[.…\s]+$/g, '');
	return out || 'Untitled';
}

/** Unique file base in a folder: if base already taken, appends " (key)". */
export async function uniqueBaseIn(
	exists: (path: string) => Promise<boolean>,
	folder: string,
	base: string,
	key: string
): Promise<string> {
	const clean = sanitizeFilename(base);
	if (!(await exists(`${folder}/${clean}.md`))) return clean;
	return `${clean} (${key})`;
}

const ZOTERO_COLORS: Record<string, string> = {
	'#ffd400': 'Yellow',
	'#ff6666': 'Red',
	'#5fb236': 'Green',
	'#2ea8e5': 'Blue',
	'#a28ae5': 'Purple',
	'#ff66b2': 'Magenta',
	'#aaaaaa': 'Gray',
	'#e56eee': 'Magenta',
};

export function colorName(hex: string | null | undefined): string | null {
	if (!hex) return null;
	const key = hex.toLowerCase();
	if (ZOTERO_COLORS[key]) return ZOTERO_COLORS[key];
	// normalize #rgb -> #rrggbb
	const m = /^#?([0-9a-f]{3})$/i.exec(key);
	if (m) {
		const full = '#' + m[1].split('').map((c) => c + c).join('');
		if (ZOTERO_COLORS[full]) return ZOTERO_COLORS[full];
	}
	return hex;
}

export const ANNOTATION_EMOJI: Record<string, string> = {
	'#ffd400': '🟨',
	'#ff6666': '🟥',
	'#5fb236': '🟩',
	'#2ea8e5': '🟦',
	'#a28ae5': '🟪',
	'#ff66b2': '🟪',
	'#aaaaaa': '⬜',
};

export function isoNow(): string {
	return new Date().toISOString();
}

export function fmtTime(iso: string | null | undefined): string {
	if (!iso) return 'never';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Zotero item page reference used in "Open in Zotero" links. */
export function zoteroItemUri(key: string): string {
	return `zotero://select/items/${key}`;
}

export function truncate(s: string, n: number): string {
	if (n <= 0 || s.length <= n) return s;
	return s.slice(0, Math.max(0, n - 1)) + '…';
}
