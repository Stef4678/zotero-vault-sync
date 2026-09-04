import { requestUrl } from 'obsidian';
import type { RequestUrlParam } from 'obsidian';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';
import type { ZoteroItem, ZoteroCollection, MirrorState } from './types';
import type { ZoteroMirrorSettings } from './settings';

/** Case-insensitive header accessor over response headers. */
export class Headers {
	constructor(private raw: Record<string, unknown> | undefined) {}

	get(name: string): string | null {
		if (!this.raw) return null;
		const lower = name.toLowerCase();
		for (const k of Object.keys(this.raw)) {
			if (k.toLowerCase() === lower) {
				const v = this.raw[k];
				if (Array.isArray(v)) return String(v[0] ?? '');
				return v == null ? null : String(v);
			}
		}
		return null;
	}

	getInt(name: string): number | null {
		const v = this.get(name);
		if (v == null) return null;
		const n = parseInt(v, 10);
		return Number.isFinite(n) ? n : null;
	}
}

export class ApiError extends Error {
	kind: 'http' | 'network' | 'invalid' | 'forbidden';
	status?: number;
	constructor(message: string, kind: ApiError['kind'], status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
	}
}

export interface ApiResponse<T> {
	status: number;
	headers: Headers;
	json: T;
	text: string;
}

export type PingResult =
	| { ok: true; serverID: string | null; libraryVersion: number | null; message: string }
	| { ok: false; kind: 'disabled' | 'forbidden' | 'unreachable' | 'unauthorized' | 'http'; status?: number; message: string };

interface RawResponse {
	status: number;
	rawHeaders: Record<string, unknown>;
	text: string;
}

/**
 * Zotero Web API v3 client with two transports:
 *  - "local": Zotero desktop's local HTTP API (http://localhost:23119/api/...).
 *    Zotero's local server is a minimal HTTP/1.0 implementation that *resets
 *    connections carrying browser-style headers* (Accept-Encoding: gzip…,
 *    browser User-Agent, Origin, Sec-Fetch-*), which is exactly what Obsidian's
 *    requestUrl (Electron/Chromium net) sends -> "ERR_EMPTY_RESPONSE". We
 *    therefore talk to it with a plain Node http request and a minimal header
 *    set, falling back to requestUrl only if Node is unavailable.
 *  - "web": api.zotero.org (Chromium requestUrl is fine against HTTPS).
 */
export class ZoteroClient {
	private _serverID: string | null = null;
	lastRequestOk = false;

	constructor(private getSettings: () => ZoteroMirrorSettings) {}

	get serverID(): string | null {
		return this._serverID;
	}

	base(): string {
		const s = this.getSettings();
		if (s.source === 'local') return s.localApiUrl;
		return `https://api.zotero.org/users/${encodeURIComponent(s.webUserId.trim())}`;
	}

	origin(): string {
		const s = this.getSettings();
		if (s.source === 'local') {
			const m = /^(https?:\/\/[^/]+)/.exec(s.localApiUrl);
			return m ? m[1] : s.localApiUrl;
		}
		return 'https://api.zotero.org';
	}

	private apiHeaders(): Record<string, string> {
		const s = this.getSettings();
		const h: Record<string, string> = { 'Zotero-API-Version': '3' };
		if (s.source === 'web') {
			if (!s.webApiKey.trim()) throw new ApiError('No Zotero API key configured.', 'invalid');
			h['Zotero-API-Key'] = s.webApiKey.trim();
		}
		if (this._serverID) h['Zotero-Server-ID'] = this._serverID;
		return h;
	}

	// ------------------------------------------------------------------ GET

	async get<T = unknown>(path: string, params: Record<string, string | number> = {}): Promise<ApiResponse<T>> {
		const s = this.getSettings();
		let url = `${this.base()}${path}`;
		const parts: string[] = [];
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined || v === null || v === '') continue;
			parts.push(`${encodeURIComponent(k)}=${String(v)}`);
		}
		if (parts.length) url += `?${parts.join('&')}`;

		const headers = this.apiHeaders();
		// Local Zotero first tries the Node http transport (proven compatible);
		// the Chromium requestUrl transport is the fallback there and the
		// primary for the HTTPS web API.
		const attempts: Array<() => Promise<RawResponse>> =
			s.source === 'local'
				? [() => this.nodeRequest(url, headers), () => this.obsidianRequest(url, headers)]
				: [() => this.obsidianRequest(url, headers), () => this.nodeRequest(url, headers)];

		const netErrors: string[] = [];
		for (const attempt of attempts) {
			try {
				const raw = await attempt();
				this.lastRequestOk = true;
				const parsed = this.toApiResponse<T>(raw);
				const sid = parsed.headers.get('Zotero-Server-ID');
				if (sid) this._serverID = sid;
				return parsed;
			} catch (e) {
				if (e instanceof ApiError && e.kind !== 'network') throw e; // authoritative HTTP answers
				netErrors.push(e instanceof Error ? e.message : String(e));
			}
		}
		this.lastRequestOk = false;
		const hint =
			s.source === 'local'
				? 'Zotero not reachable. Is Zotero running with "Allow other applications on this computer to communicate with Zotero" enabled (Settings → Advanced)? If the mirror still fails after a full Zotero restart, check the port in Settings.'
				: 'zotero.org not reachable. Check the user id, API key and your internet connection.';
		throw new ApiError(`Cannot reach Zotero: ${netErrors.join(' | ')} — ${hint}`, 'network');
	}

	/** Obsidian requestUrl (Electron net). Breaks against Zotero's local HTTP/1.0 server; fine for HTTPS. */
	private async obsidianRequest(url: string, headers: Record<string, string>): Promise<RawResponse> {
		const req: RequestUrlParam = { url, method: 'GET', headers, throw: true };
		let resp;
		try {
			resp = await requestUrl(req);
		} catch (e) {
			const status = (e as { status?: number }).status;
			if (status != null) {
				this.throwForStatus(status, url);
			}
			const msg = (e as Error).message || 'network error';
			throw new ApiError(`requestUrl failed: ${msg}`, 'network');
		}
		this.throwForStatus(resp.status, url);
		return { status: resp.status, rawHeaders: resp.headers, text: resp.text };
	}

	/** Plain Node http(s) request with a minimal header set (works against Zotero's local server). */
	private nodeRequest(url: string, headers: Record<string, string>): Promise<RawResponse> {
		return new Promise<RawResponse>((resolve, reject) => {
			let u: URL;
			try {
				u = new URL(url);
			} catch {
				reject(new ApiError(`Invalid URL: ${url}`, 'invalid'));
				return;
			}
			const isHttps = u.protocol === 'https:';
			const doGet: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest = isHttps
				? httpsGet
				: httpGet;
			const req = doGet(
				{
					hostname: u.hostname,
					port: u.port || undefined,
					path: u.pathname + u.search,
					method: 'GET',
					headers: {
						Connection: 'close',
						...headers,
					},
				},
				(res: IncomingMessage) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => {
						chunks.push(chunk);
					});
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						try {
							this.throwForStatus(res.statusCode ?? 0, url);
						} catch (e) {
							reject(e instanceof Error ? e : new ApiError(String(e), 'http'));
							return;
						}
						resolve({ status: res.statusCode ?? 0, rawHeaders: res.headers, text });
					});
					res.on('error', (e: Error) =>
						reject(new ApiError(`node http response error: ${e.message}`, 'network'))
					);
				}
			);
			req.setTimeout(20_000, () => {
				req.destroy(new Error('timeout'));
			});
			req.on('error', (e: Error) => reject(new ApiError(`node http: ${e.message}`, 'network')));
		});
	}

	private throwForStatus(status: number, url: string): void {
		const s = this.getSettings();
		if (status < 400) return;
		if (status === 403) {
			const msg =
				s.source === 'local'
					? 'Zotero refused the request (403). Enable "Allow other applications on this computer to communicate with Zotero" in Zotero → Settings → Advanced.'
					: 'Zotero API key rejected (403). Check the key and its permissions.';
			throw new ApiError(msg, 'forbidden', status);
		}
		if (status === 404) throw new ApiError(`Zotero endpoint not found (404) for ${url}`, 'http', status);
		if (status === 400) throw new ApiError(`Zotero rejected the request (400) for ${url}`, 'http', status);
		if (status === 501) throw new ApiError('Zotero local API does not support this request (501).', 'http', status);
		throw new ApiError(`Zotero HTTP ${status} for ${url}`, 'http', status);
	}

	private toApiResponse<T>(raw: RawResponse): ApiResponse<T> {
		const headers = new Headers(raw.rawHeaders);
		let json: T;
		try {
			json = (raw.text ? JSON.parse(raw.text) : null) as T;
		} catch {
			json = raw.text as unknown as T;
		}
		return { status: raw.status, headers, json, text: raw.text };
	}

	// ------------------------------------------------------------------ API

	async ping(): Promise<PingResult> {
		const s = this.getSettings();
		if (s.source === 'web' && (!s.webUserId.trim() || !s.webApiKey.trim())) {
			return { ok: false, kind: 'unauthorized', message: 'Web API source needs a user id and API key (settings).' };
		}
		try {
			const r = await this.get('/items', { limit: 1, format: 'json' });
			return {
				ok: true,
				serverID: this._serverID,
				libraryVersion: r.headers.getInt('Last-Modified-Version'),
				message: `${s.source === 'local' ? 'Zotero desktop' : 'zotero.org'} reachable (library version ${r.headers.getInt('Last-Modified-Version') ?? '?'})`,
			};
		} catch (e) {
			if (e instanceof ApiError) {
				if (e.kind === 'forbidden') {
					return {
						ok: false,
						kind: s.source === 'local' ? 'disabled' : 'forbidden',
						status: e.status,
						message: e.message,
					};
				}
				let kind: 'unreachable' | 'unauthorized' | 'http';
				if (e.kind === 'network') kind = 'unreachable';
				else if (e.kind === 'invalid') kind = 'unauthorized';
				else kind = 'http';
				return { ok: false, kind, status: e.status, message: e.message };
			}
			return { ok: false, kind: 'unreachable', message: String(e) };
		}
	}

	async fetchItemsSince(since: number, onProgress?: (batchSize: number, total: number | null) => void): Promise<{
		items: ZoteroItem[];
		libraryVersion: number;
	}> {
		return this.paginate<ZoteroItem>('/items', { since, format: 'json' }, onProgress);
	}

	async fetchCollectionsSince(since: number): Promise<{ collections: ZoteroCollection[]; libraryVersion: number }> {
		const { items: collections, libraryVersion } = await this.paginate<ZoteroCollection>('/collections', {
			since,
			format: 'json',
		});
		return { collections, libraryVersion };
	}

	async fetchItemsByKey(keys: string[]): Promise<{ items: ZoteroItem[]; libraryVersion: number }> {
		const out: ZoteroItem[] = [];
		let libVersion = 0;
		const CHUNK = 50;
		for (let i = 0; i < keys.length; i += CHUNK) {
			const chunk = keys.slice(i, i + CHUNK);
			const r = await this.get<ZoteroItem[]>('/items', {
				itemKey: chunk.map((k) => encodeURIComponent(k)).join(','),
				format: 'json',
			});
			if (Array.isArray(r.json)) out.push(...r.json);
			libVersion = Math.max(libVersion, r.headers.getInt('Last-Modified-Version') ?? 0);
		}
		return { items: out, libraryVersion: libVersion };
	}

	/** key -> version for every (non-trashed) item. */
	async fetchItemVersions(): Promise<Map<string, number>> {
		const r = await this.get<Record<string, number> | null>('/items', { format: 'versions' });
		const map = new Map<string, number>();
		if (r.json && typeof r.json === 'object') {
			for (const [k, v] of Object.entries(r.json)) map.set(k, typeof v === 'number' ? v : parseInt(String(v), 10) || 0);
		}
		return map;
	}

	async fetchCollectionVersions(): Promise<Map<string, number>> {
		const r = await this.get<Record<string, number> | null>('/collections', { format: 'versions' });
		const map = new Map<string, number>();
		if (r.json && typeof r.json === 'object') {
			for (const [k, v] of Object.entries(r.json)) map.set(k, typeof v === 'number' ? v : parseInt(String(v), 10) || 0);
		}
		return map;
	}

	private async paginate<T extends { key: string; version: number }>(
		path: string,
		params: Record<string, string | number>,
		onProgress?: (batchSize: number, total: number | null) => void
	): Promise<{ items: T[]; libraryVersion: number }> {
		const items: T[] = [];
		let libVersion = 0;
		let start = 0;
		const limit = 100;
		for (;;) {
			const r = await this.get<T[]>(path, { ...params, limit, start });
			const batch = Array.isArray(r.json) ? r.json : [];
			items.push(...batch);
			libVersion = Math.max(libVersion, r.headers.getInt('Last-Modified-Version') ?? 0);
			const total = r.headers.getInt('Total-Results');
			onProgress?.(batch.length, total);
			if (batch.length < limit) break;
			if (total != null && start + batch.length >= total) break;
			start += batch.length;
			if (start > 1_000_000) break; // safety valve
		}
		return { items, libraryVersion: libVersion };
	}

	/** Record a server-ID change so the sync engine can reset caches. */
	static fingerprint(state: MirrorState | null, serverID: string | null, sourceType: string, baseUrl: string): string {
		if (serverID) return `sid:${serverID}`;
		return `${sourceType}:${baseUrl}`;
	}
}
