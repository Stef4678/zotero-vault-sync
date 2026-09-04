export type SyncSourceType = 'local' | 'web';

export interface ZoteroMirrorSettings {
	/** Data source. "local" = Zotero desktop's local HTTP API (default). */
	source: SyncSourceType;
	/** Local API base (path up to, but not including, the resource). */
	localApiUrl: string;
	/** zotero.org numeric user id (for the "web" source). */
	webUserId: string;
	/** zotero.org API key (for the "web" source). */
	webApiKey: string;

	/** Vault folder that holds the mirror. Leading underscore = visible in
	 *  Obsidian's file explorer; a leading dot (".zotero") hides it. */
	mirrorFolder: string;

	/** Sync triggers. pollIntervalSeconds 0 disables background polling. */
	syncOnStartup: boolean;
	syncOnWindowFocus: boolean;
	pollIntervalSeconds: number;
	/** How often (minutes) to reconcile deletions by diffing format=versions.
	 *  0 = only on manual "Full sync" and on startup. */
	reconcileMinutes: number;

	/** Generated notes ("views") live here (outside the mirror). */
	noteFolder: string;
	/** Optional vault path to a custom template file (see README for tokens). */
	noteTemplatePath: string;
	/** 'region' preserves user text outside the generated markers. */
	noteOverwrite: 'region' | 'full';
	/** Include child notes / attachment / annotation sections in generated notes. */
	includeChildNotes: boolean;
	includeAttachments: boolean;
	includeAnnotations: boolean;
	/** Truncate annotation quotes inside generated notes (0 = no truncation). */
	noteAnnotationPreviewLength: number;
	/** Max creators to list before "et al." in generated notes. */
	noteMaxCreators: number;

	/** Generated Dataview dashboard notes (require the Dataview plugin). */
	viewsFolder: string;
	/** Create the Dataview view notes automatically once the first mirror completes. */
	viewsAutoCreate: boolean;
}

export const DEFAULT_SETTINGS: ZoteroMirrorSettings = {
	source: 'local',
	localApiUrl: 'http://127.0.0.1:23119/api/users/0',
	webUserId: '',
	webApiKey: '',

	mirrorFolder: '_zotero',

	syncOnStartup: true,
	syncOnWindowFocus: true,
	pollIntervalSeconds: 60,
	reconcileMinutes: 5,

	noteFolder: 'Zotero Notes',
	noteTemplatePath: '',
	noteOverwrite: 'region',
	includeChildNotes: true,
	includeAttachments: true,
	includeAnnotations: true,
	noteAnnotationPreviewLength: 500,
	noteMaxCreators: 6,

	viewsFolder: 'Zotero Views',
	viewsAutoCreate: true,
};

export function normalizeSettings(raw: unknown): ZoteroMirrorSettings {
	const s = { ...DEFAULT_SETTINGS } as ZoteroMirrorSettings;
	if (!raw || typeof raw !== 'object') return s;
	const r = raw as Record<string, unknown>;
	if (r.source === 'web' || r.source === 'local') s.source = r.source;
	if (typeof r.localApiUrl === 'string' && r.localApiUrl) s.localApiUrl = r.localApiUrl.replace(/\/+$/, '');
	if (typeof r.webUserId === 'string') s.webUserId = r.webUserId;
	if (typeof r.webApiKey === 'string') s.webApiKey = r.webApiKey;
	if (typeof r.mirrorFolder === 'string' && r.mirrorFolder.trim()) s.mirrorFolder = r.mirrorFolder.trim().replace(/^\/+|\/+$/g, '');
	if (typeof r.syncOnStartup === 'boolean') s.syncOnStartup = r.syncOnStartup;
	if (typeof r.syncOnWindowFocus === 'boolean') s.syncOnWindowFocus = r.syncOnWindowFocus;
	if (typeof r.pollIntervalSeconds === 'number' && r.pollIntervalSeconds >= 0) s.pollIntervalSeconds = r.pollIntervalSeconds;
	if (typeof r.reconcileMinutes === 'number' && r.reconcileMinutes >= 0) s.reconcileMinutes = r.reconcileMinutes;
	if (typeof r.noteFolder === 'string' && r.noteFolder.trim()) s.noteFolder = r.noteFolder.trim().replace(/^\/+|\/+$/g, '');
	if (typeof r.noteTemplatePath === 'string') s.noteTemplatePath = r.noteTemplatePath;
	if (r.noteOverwrite === 'region' || r.noteOverwrite === 'full') s.noteOverwrite = r.noteOverwrite;
	if (typeof r.includeChildNotes === 'boolean') s.includeChildNotes = r.includeChildNotes;
	if (typeof r.includeAttachments === 'boolean') s.includeAttachments = r.includeAttachments;
	if (typeof r.includeAnnotations === 'boolean') s.includeAnnotations = r.includeAnnotations;
	if (typeof r.noteAnnotationPreviewLength === 'number' && r.noteAnnotationPreviewLength >= 0)
		s.noteAnnotationPreviewLength = r.noteAnnotationPreviewLength;
	if (typeof r.noteMaxCreators === 'number' && r.noteMaxCreators > 0) s.noteMaxCreators = r.noteMaxCreators;
	if (typeof r.viewsFolder === 'string' && r.viewsFolder.trim())
		s.viewsFolder = r.viewsFolder.trim().replace(/^\/+|\/+$/g, '');
	if (typeof r.viewsAutoCreate === 'boolean') s.viewsAutoCreate = r.viewsAutoCreate;
	return s;
}

export function sourceLabel(s: ZoteroMirrorSettings): string {
	return s.source === 'web' ? 'zotero.org Web API' : 'Zotero desktop (local API)';
}
