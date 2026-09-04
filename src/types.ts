/**
 * Shared types: Zotero Web/Local API v3 payloads (the subset we mirror) and
 * the on-disk mirror model.
 *
 * All mirror content lives under the vault mirror folder (default `_zotero/`):
 *   items/<key>.json            – one file per Zotero item (bibliographic items,
 *                                 notes, attachments AND annotations), keyed by
 *                                 Zotero's item key. Content is the cleaned API
 *                                 record: { key, version, itemType, meta, data, ... }.
 *   annotations/<attachKey>.json– per-PDF aggregated annotation files (derived,
 *                                 regenerated from items/ whenever they change).
 *   collections.json            – collections (raw API records).
 *   index.json                  – regenerable search index + item summaries.
 *   .state.json                 – sync cursor (library version, times, counts).
 *   notes.json                  – registry key -> generated-note path (derived).
 *   README.md                   – created once.
 */

export type ZoteroItemType = string;

/** Raw item record exactly as returned by `?format=json` (kept for fidelity). */
export interface ZoteroItem {
	key: string;
	version: number;
	library?: { type: 'user' | 'group'; id: number; name?: string };
	links?: unknown;
	meta?: {
		creatorSummary?: string;
		parsedDate?: string;
		numChildren?: number;
		[field: string]: unknown;
	};
	/** Writable fields ("data" include): creators, title, abstractNote, tags, collections, ... */
	data: ZoteroItemData;
}

export interface ZoteroCreator {
	creatorType?: string;
	firstName?: string;
	lastName?: string;
	name?: string;
	fieldMode?: number;
}

export interface ZoteroTag {
	tag: string;
	type?: number;
}

export interface ZoteroItemData {
	key: string;
	version: number;
	itemType: ZoteroItemType;
	creators?: ZoteroCreator[];
	/** For notes: HTML body; for annotations: highlight text etc. */
	note?: string;
	abstractNote?: string;
	title?: string;
	filename?: string;
	contentType?: string;
	linkMode?: string;
	parentItem?: string | null;
	dateAdded?: string;
	dateModified?: string;
	accessDate?: string;
	date?: string;
	DOI?: string;
	url?: string;
	publicationTitle?: string;
	proceedingsTitle?: string;
	bookTitle?: string;
	journalAbbreviation?: string;
	series?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	edition?: string;
	publisher?: string;
	place?: string;
	language?: string;
	ISBN?: string;
	ISSN?: string;
	callNumber?: string;
	archive?: string;
	archiveLocation?: string;
	extra?: string;
	rights?: string;
	collections: string[];
	tags: ZoteroTag[];
	relations: Record<string, string[]>;
	/** Annotation fields (Zotero 7+, itemType = "annotation") */
	annotationText?: string;
	annotationComment?: string;
	annotationColor?: string;
	annotationPageLabel?: string;
	annotationSortIndex?: string;
	annotationPosition?: string;
	md5?: string;
	mtime?: number | string;
	size?: number | string;
	[field: string]: unknown;
}

export interface ZoteroCollection {
	key: string;
	version: number;
	library?: { type: 'user' | 'group'; id: number; name?: string };
	meta?: unknown;
	data: {
		key: string;
		version: number;
		name: string;
		parentCollection: string | false;
		dateAdded?: string;
		dateModified?: string;
		relations?: Record<string, string[]>;
	};
}

/** Lightweight per-item summary persisted inside index.json (regenerable). */
export interface ItemSummary {
	key: string;
	version: number;
	itemType: string;
	/** Human readable title (attachment => filename, note => "Note") */
	title: string | null;
	/** "Doe, John; Smith, J." style creator string */
	creators: string | null;
	year: string | null;
	date: string | null;
	parentItem: string | null;
	collections: string[];
	tags: string[];
}

export interface CollectionSummary {
	key: string;
	version: number;
	name: string;
	parentCollection: string | false;
}

/** One aggregated annotation entry inside annotations/<attachmentKey>.json */
export interface AnnotationEntry {
	key: string;
	version: number;
	color: string | null;
	colorName: string | null;
	pageLabel: string | null;
	pageIndex: number | null;
	text: string;
	comment: string;
	sortIndex: string | null;
	sortPosition: [number, number] | null;
	position: unknown;
	dateModified: string | null;
}

export interface AnnotationFile {
	schema: number;
	attachmentKey: string;
	parentItemKey: string | null;
	libraryVersion: number;
	filename: string | null;
	title: string | null;
	contentType: string | null;
	generatedAt: string;
	annotations: AnnotationEntry[];
}

export interface MirrorIndex {
	schema: number;
	source: { type: string; label: string };
	generatedAt: string;
	libraryVersion: number;
	counts: { items: number; attachments: number; annotations: number; notes: number; topLevel: number };
	items: ItemSummary[];
}

export interface MirrorState {
	schema: number;
	sourceType: 'local' | 'web';
	sourceFingerprint: string;
	serverID: string | null;
	libraryVersion: number;
	collectionsVersion: number;
	hasData: boolean;
	lastSyncedAt: string | null;
	lastReconcileAt: string | null;
	lastError: string | null;
	counts: { items: number; annotations: number };
}

export const MIRROR_SCHEMA = 1;
export const INDEX_SCHEMA = 1;
