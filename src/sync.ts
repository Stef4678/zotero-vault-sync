import { ZoteroClient, ApiError } from './api';
import { Mirror } from './mirror';
import { ZoteroMirrorSettings } from './settings';
import { ZoteroCollection, ZoteroItem, MirrorState } from './types';
import { isoNow } from './util';

export type EngineStatus =
	| { phase: 'idle'; message: string }
	| { phase: 'connecting'; message: string }
	| { phase: 'syncing'; message: string }
	| { phase: 'reconciling'; message: string }
	| { phase: 'error'; message: string }
	| { phase: 'offline'; message: string };

export interface SyncResult {
	ok: boolean;
	full: boolean;
	added: number;
	updated: number;
	removed: number;
	collectionsChanged: number;
	hadChanges: boolean;
	reconciled: boolean;
	message: string;
	errorKind?: string;
}

export interface SyncEngineHooks {
	onStatus(status: EngineStatus): void;
	/** Called for important, user-visible transitions only. */
	onAlert?(message: string, kind: 'error' | 'info'): void;
}

/**
 * Incremental mirror synchronizer.
 *
 * While polling we fetch only items whose version is newer than the last seen
 * library version (`?since=`), and touch exactly those item files. Deletions
 * are invisible to `since`, so on a cadence — and on every full/manual sync
 * and after the very first sync — we pull a complete snapshot and diff it
 * against the mirror, removing item/annotation files that vanished upstream.
 * For the local API the full snapshot is a single unpaginated request; for
 * the web API it is the documented paged `since=0` pull.
 */
export class SyncEngine {
	private busy = false;
	private pending = false;
	private pendingFull = false;
	private lastStatus: EngineStatus = { phase: 'idle', message: 'Not synced yet' };
	private lastError: string | null = null;

	constructor(
		private mirror: Mirror,
		private client: ZoteroClient,
		private getSettings: () => ZoteroMirrorSettings,
		private hooks: SyncEngineHooks
	) {}

	get isBusy(): boolean {
		return this.busy;
	}

	get status(): EngineStatus {
		return this.lastStatus;
	}

	private setStatus(s: EngineStatus): void {
		this.lastStatus = s;
		this.hooks.onStatus(s);
	}

	/** Coalescing entry point — safe from intervals, focus events, commands. */
	async requestSync(full = false): Promise<SyncResult> {
		if (this.busy) {
			this.pending = true;
			if (full) this.pendingFull = true;
			return {
				ok: true, full, added: 0, updated: 0, removed: 0, collectionsChanged: 0,
				hadChanges: false, reconciled: false, message: 'Sync already running — queued.',
			};
		}
		this.busy = true;
		try {
			return await this.run(full);
		} finally {
			this.busy = false;
			if (this.pending) {
				this.pending = false;
				const f = this.pendingFull;
				this.pendingFull = false;
				setTimeout(() => void this.requestSync(f), 0);
			}
		}
	}

	private async run(full: boolean): Promise<SyncResult> {
		const settings = this.getSettings();
		const started = Date.now();
		const res: SyncResult = {
			ok: true, full, added: 0, updated: 0, removed: 0, collectionsChanged: 0,
			hadChanges: false, reconciled: false, message: '',
		};

		this.setStatus({ phase: 'connecting', message: 'Contacting Zotero…' });
		const ping = await this.client.ping();
		if (!ping.ok) {
			res.ok = false;
			res.message = ping.message;
			res.errorKind = ping.kind;
			this.setStatus({ phase: ping.kind === 'unreachable' ? 'offline' : 'error', message: ping.message });
			this.recordError(ping.kind === 'unreachable' ? 'Zotero not reachable.' : ping.message);
			return res;
		}

		try {
			await this.mirror.load();
			await this.mirror.ensureDirectories();

			const state = this.mirror.getState();
			const fingerprint = this.computeFingerprint();
			const sourceChanged = !!state?.hasData && state.sourceFingerprint !== fingerprint;
			if (sourceChanged) {
				await this.mirror.reset();
				this.hooks.onAlert?.('Zotero data source changed — mirror reset; full re-sync started.', 'info');
				full = true;
			}

			const isFirst = !state?.hasData || sourceChanged;
			if (isFirst) full = true;
			res.full = full;

			let reconcile = full;
			if (!reconcile && settings.reconcileMinutes > 0) {
				const last = state?.lastReconcileAt ? new Date(state.lastReconcileAt).getTime() : 0;
				reconcile = !last || Date.now() - last >= settings.reconcileMinutes * 60_000;
			}
			res.reconciled = reconcile;

			this.mirror.setState({
				sourceType: settings.source,
				sourceFingerprint: fingerprint,
				serverID: this.client.serverID,
			});

			let libraryVersion = state?.libraryVersion ?? 0;
			let collectionsVersion = state?.collectionsVersion ?? 0;

			if (full) {
				// ---- complete snapshot: update everything + detect deletions ----
				this.setStatus({ phase: 'syncing', message: 'Pulling full snapshot…' });
				const { items, libraryVersion: lv } = await this.client.fetchItemsSince(0);
				libraryVersion = Math.max(libraryVersion, lv);
				const remoteKeys = new Set(items.map((i) => i.key));
				await this.applyItems(items, res);

				for (const s of [...this.mirror.summaries()]) {
					if (!remoteKeys.has(s.key)) {
						const existed = await this.mirror.removeItem(s.key);
						if (existed) res.removed++;
					}
				}

				// The local API's `since=0` may skip never-synced items (version 0).
				// The versions map lists every key, so pull anything still missing.
				if (settings.source === 'local') {
					const versions = await this.client.fetchItemVersions();
					const missingKeys: string[] = [];
					for (const k of versions.keys()) if (!remoteKeys.has(k)) missingKeys.push(k);
					if (missingKeys.length) {
						const extra = await this.client.fetchItemsByKey(missingKeys);
						await this.applyItems(extra.items, res);
						for (const k of missingKeys) remoteKeys.add(k);
					}
				}

				this.setStatus({ phase: 'syncing', message: 'Syncing collections…' });
				const { collections, libraryVersion: clv } = await this.client.fetchCollectionsSince(0);
				collectionsVersion = Math.max(collectionsVersion, clv);
				await this.applyCollections(collections, res, true);
			} else {
				// ---- incremental: only objects newer than our cursor ----
				this.setStatus({ phase: 'syncing', message: 'Fetching changes…' });
				const since = state?.libraryVersion ?? 0;
				if (since > 0) {
					const { items, libraryVersion: lv } = await this.client.fetchItemsSince(since);
					libraryVersion = Math.max(libraryVersion, lv);
					await this.applyItems(items, res);
				}
				const csince = state?.collectionsVersion ?? 0;
				if (csince > 0) {
					const { collections, libraryVersion: clv } = await this.client.fetchCollectionsSince(csince);
					collectionsVersion = Math.max(collectionsVersion, clv);
					await this.applyCollections(collections, res, false);
				}
			}

			res.hadChanges = res.added + res.updated + res.removed > 0 || res.collectionsChanged > 0;
			const now = isoNow();
			const dirty = res.hadChanges || this.lastError !== null;
			const maxVer = Math.max(libraryVersion, collectionsVersion);
			const patch: Partial<MirrorState> = {
				libraryVersion: maxVer,
				collectionsVersion,
				hasData: true,
				lastError: null,
			};
			if (reconcile) patch.lastReconcileAt = now;
			if (dirty) patch.lastSyncedAt = now;
			this.mirror.setState(patch);
			this.lastError = null;

			await this.mirror.commitDerived(maxVer, false);

			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const bits: string[] = [];
			if (full) bits.push('full snapshot');
			if (res.added) bits.push(`${res.added} new`);
			if (res.updated) bits.push(`${res.updated} updated`);
			if (res.removed) bits.push(`${res.removed} removed`);
			if (res.collectionsChanged) bits.push(`${res.collectionsChanged} collections`);
			res.message = bits.length ? `Synced (${secs}s): ${bits.join(', ')}` : `Up to date (${secs}s)`;
			this.setStatus({ phase: 'idle', message: res.message });
			return res;
		} catch (e) {
			res.ok = false;
			res.message = e instanceof Error ? e.message : String(e);
			res.errorKind = e instanceof ApiError ? e.kind : 'internal';
			this.setStatus({ phase: 'error', message: res.message });
			this.recordError(res.message);
			return res;
		}
	}

	private computeFingerprint(): string {
		const settings = this.getSettings();
		if (this.client.serverID) return `sid:${this.client.serverID}`;
		return `${settings.source}:${this.client.base()}`;
	}

	/** Upsert changed item records in bounded-parallel batches. */
	private async applyItems(items: ZoteroItem[], res: SyncResult): Promise<void> {
		const toWrite: ZoteroItem[] = [];
		for (const it of items) {
			if (!it?.key || !it?.data) continue;
			const existing = this.mirror.summary(it.key);
			if (existing && existing.version === it.version) continue; // unchanged
			toWrite.push(it);
			if (existing) res.updated++;
			else res.added++;
		}
		for (let i = 0; i < toWrite.length; i += 50) {
			const chunk = toWrite.slice(i, i + 50);
			await Promise.all(chunk.map((it) => this.mirror.upsertItem(it)));
		}
	}

	private async applyCollections(
		list: ZoteroCollection[],
		res: SyncResult,
		removeStale: boolean
	): Promise<void> {
		if (!list.length && !removeStale) return;
		let changed = await this.mirror.upsertCollections(list.filter((c) => c?.key));
		if (removeStale) {
			const remoteKeys = new Set(list.map((c) => c.key).filter(Boolean));
			const stale: string[] = [];
			for (const c of this.mirror.collectionsList()) if (!remoteKeys.has(c.key)) stale.push(c.key);
			if (stale.length) {
				this.mirror.removeCollections(stale);
				changed += stale.length;
			}
		}
		res.collectionsChanged += changed;
	}

	private recordError(message: string): void {
		if (this.lastError === message) return;
		this.lastError = message;
		const st = this.mirror.getState();
		if (st && st.lastError !== message) {
			this.mirror.setState({ lastError: message });
			this.mirror.touchState();
			void this.mirror.commitDerived(st.libraryVersion, false).catch(() => undefined);
		}
	}
}
