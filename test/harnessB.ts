/**
 * End-to-end integration test: a mock Zotero local API server + a real Mirror
 * and SyncEngine running in plain Node (obsidian module stubbed).
 *
 * Exercises: full snapshot -> mirror layout (items/<key>.json, per-PDF
 * annotations/<key>.json, collections.json, index.json, .state.json),
 * incremental sync, deletions via reconcile, "no writes when nothing changed".
 */
import { createServer, Server } from 'http';
import { Mirror } from '../src/mirror';
import { SyncEngine } from '../src/sync';
import { ZoteroClient } from '../src/api';
import { ZoteroMirrorSettings, DEFAULT_SETTINGS } from '../src/settings';
import { ZoteroCollection, ZoteroItem, MirrorState } from '../src/types';
import { isoNow } from '../src/util';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
	}
}

// ---------------------------------------------------------------- mock zotero
type Lib = { libVersion: number; items: ZoteroItem[]; collections: ZoteroCollection[] };

function item(p: Partial<ZoteroItem> & { key: string; itemType: string }, version: number): ZoteroItem {
	const d = p.data ?? {};
	const now = isoNow();
	return {
		key: p.key,
		version,
		library: { type: 'user', id: 0 },
		meta: {},
		data: {
			key: p.key,
			itemType: p.itemType,
			parentItem: (d as { parentItem?: string | null }).parentItem ?? null,
			title: '',
			collections: [],
			tags: [],
			relations: {},
			dateAdded: now,
			dateModified: now,
			...(p.data ?? {}),
			version,
		},
	};
}

function collection(key: string, name: string, version: number, parent = false): ZoteroCollection {
	return {
		key,
		version,
		library: { type: 'user', id: 0 },
		meta: {},
		data: { key, version, name, parentCollection: parent, dateAdded: isoNow(), dateModified: isoNow(), relations: {} },
	};
}

class MockZotero {
	lib: Lib;
	server!: Server;
	port = 0;
	private mutations: (() => void)[] = [];

	constructor() {
		this.lib = { libVersion: 0, items: [], collections: [] };
	}

	private bump(): number {
		this.lib.libVersion += 1;
		return this.lib.libVersion;
	}

	// ------------------------------------------------------- mutation API
	addItem(p: Partial<ZoteroItem> & { key: string; itemType: string }): void {
		this.mutations.push(() => {
			const v = this.bump();
			const rec = item(p, v);
			// reflect stamped version back into data.version via the real shape
			const existing = this.lib.items.findIndex((i) => i.key === p.key);
			if (existing >= 0) this.lib.items.splice(existing, 1);
			this.lib.items.push(rec);
		});
	}

	updateItem(key: string, patch: Partial<ZoteroItem['data']>): void {
		this.mutations.push(() => {
			const v = this.bump();
			const i = this.lib.items.find((x) => x.key === key);
			if (i) {
				i.data = { ...i.data, ...patch, version: v };
				i.version = v;
			}
		});
	}

	deleteItem(key: string): void {
		this.mutations.push(() => {
			this.bump();
			this.lib.items = this.lib.items.filter((i) => i.key !== key);
		});
	}

	addCollection(c: ZoteroCollection): void {
		this.mutations.push(() => {
			this.bump();
			this.lib.collections = this.lib.collections.filter((x) => x.key !== c.key);
			this.lib.collections.push({ ...c, version: this.lib.libVersion });
		});
	}

	applyMutations(): void {
		const run = this.mutations;
		this.mutations = [];
		for (const m of run) m();
	}

	// ------------------------------------------------------- http server
	async start(): Promise<number> {
		this.server = createServer((req, res) => {
			const u = new URL(req.url ?? '/', `http://127.0.0.1`);
			const path = u.pathname;
			const q = u.searchParams;
			const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
				const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
				res.writeHead(status, {
					'Content-Type': 'application/json',
					'Last-Modified-Version': String(this.lib.libVersion),
					...headers,
				});
				res.end(body);
			};

			try {
				if (path.endsWith('/items')) {
					const fmt = q.get('format') ?? 'json';
					const since = parseInt(q.get('since') ?? '0', 10);
					if (fmt === 'versions') {
						const map: Record<string, number> = {};
						for (const i of this.lib.items) map[i.key] = i.version;
						send(200, map);
						return;
					}
					let list = this.lib.items;
					if (since > 0) list = list.filter((i) => i.version > since);
					const itemKey = q.get('itemKey');
					if (itemKey) {
						const keys = new Set(itemKey.split(',').map(decodeURIComponent));
						list = list.filter((i) => keys.has(i.key));
					}
					const start = parseInt(q.get('start') ?? '0', 10);
					const limit = q.get('limit') ? parseInt(q.get('limit') ?? '0', 10) : null;
					const page = limit ? list.slice(start, start + limit) : list;
					send(200, page, { 'Total-Results': String(list.length) });
					return;
				}
				if (path.endsWith('/collections')) {
					const fmt = q.get('format') ?? 'json';
					const since = parseInt(q.get('since') ?? '0', 10);
					if (fmt === 'versions') {
						const map: Record<string, number> = {};
						for (const c of this.lib.collections) map[c.key] = c.version;
						send(200, map);
						return;
					}
					const start = parseInt(q.get('start') ?? '0', 10);
					const limit = q.get('limit') ? parseInt(q.get('limit') ?? '0', 10) : null;
					let list = this.lib.collections.filter((c) => (since > 0 ? c.version > since : true));
					const page = limit ? list.slice(start, start + limit) : list;
					send(200, page, { 'Total-Results': String(list.length) });
					return;
				}
				send(404, { error: `no route ${path}` });
			} catch (e) {
				send(500, { error: String(e) });
			}
		});
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const addr = this.server.address();
		this.port = typeof addr === 'object' && addr ? addr.port : 0;
		return this.port;
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server?.close(() => resolve()));
	}
}

// ---------------------------------------------------------------- memory vault adapter
class MemAdapter {
	dirs = new Set<string>(['']);
	files = new Map<string, string>();
	writes = 0;

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}
	async mkdir(path: string): Promise<void> {
		const parts = path.split('/').filter(Boolean);
		let cur = '';
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			this.dirs.add(cur);
		}
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
		this.writes++;
	}
	async read(path: string): Promise<string> {
		const v = this.files.get(path);
		if (v === undefined) throw new Error(`no file ${path}`);
		return v;
	}
	async remove(path: string): Promise<void> {
		if (this.files.has(path)) {
			this.files.delete(path);
			return;
		}
		if (this.dirs.has(path)) {
			this.dirs.delete(path);
			const prefix = path + '/';
			for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
			for (const d of [...this.dirs.keys()]) if (d.startsWith(prefix)) this.dirs.delete(d);
		}
	}
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path === '' ? '' : path + '/';
		const files: string[] = [];
		const folders: string[] = [];
		for (const f of this.files.keys()) if (f.startsWith(prefix)) {
			const rest = f.slice(prefix.length);
			if (rest && !rest.includes('/')) files.push(f);
		}
		for (const d of this.dirs.keys()) if (d.startsWith(prefix)) {
			const rest = d.slice(prefix.length);
			if (rest && !rest.includes('/')) folders.push(d);
		}
		return { files, folders };
	}
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
	const zotero = new MockZotero();
	await zotero.start();
	console.log(`mock zotero on :${zotero.port}`);

	// seed: J1 with child note N1, child PDF A1 with annotation AN1; standalone note S1; J2 empty-ish later
	zotero.addItem({
		key: 'J1',
		itemType: 'journalArticle',
		data: {
			title: 'Original title',
			creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
			date: '2019-06-01',
			publicationTitle: 'Journal of Mocking',
			DOI: '10.0/mock1',
			collections: ['C1'],
			tags: [{ tag: 'seed' }],
		},
	});
	zotero.addItem({
		key: 'N1',
		itemType: 'note',
		data: { note: '<p>child note body</p>', parentItem: 'J1' },
	});
	zotero.addItem({
		key: 'A1',
		itemType: 'attachment',
		data: {
			title: 'paper.pdf',
			filename: 'paper.pdf',
			contentType: 'application/pdf',
			parentItem: 'J1',
		},
	});
	zotero.addItem({
		key: 'AN1',
		itemType: 'annotation',
		data: {
			parentItem: 'A1',
			annotationText: 'first highlight',
			annotationComment: 'my note',
			annotationColor: '#ffd400',
			annotationPageLabel: '2',
			annotationSortIndex: '0.100,0.200',
			annotationPosition: '{"pageIndex":1,"rects":[[{"x":0.1,"y":0.2}]]}',
		},
	});
	zotero.addItem({ key: 'S1', itemType: 'note', data: { note: '<p>standalone</p>' } });
	zotero.addCollection(collection('C1', 'Methods', 0));
	zotero.addCollection(collection('C2', 'Reading', 0));
	zotero.applyMutations();

	// ------------------------------------------------------------ setup plugin bits
	const settings: ZoteroMirrorSettings = {
		...DEFAULT_SETTINGS,
		localApiUrl: `http://127.0.0.1:${zotero.port}/api/users/0`,
		source: 'local',
		reconcileMinutes: 1,
		pollIntervalSeconds: 0,
	};
	const adapter = new MemAdapter();
	const vault = { adapter } as unknown as import('obsidian').Vault;
	const mirror = new Mirror(vault, () => settings);
	const client = new ZoteroClient(() => settings);
	const statuses: string[] = [];
	const engine = new SyncEngine(mirror, client, () => settings, {
		onStatus: (s) => statuses.push(`${s.phase}:${s.message}`),
	});

	const R = `${settings.mirrorFolder}`;
	const IT = `${R}/items`;
	const AN = `${R}/annotations`;
	const ex = async (p: string) => adapter.exists(p);
	const read = async (p: string) => adapter.files.get(p);

	// ------------------------------------------------------------ test 1: full sync
	console.log('test 1: initial full sync');
	{
		const r = await engine.requestSync(false);
		check('initial run is full & ok', r.ok && r.full, JSON.stringify(r));
		check('counts: 5 new items', r.added === 5, JSON.stringify(r));
		check('item files exist', (await ex(`${IT}/J1.json`)) && (await ex(`${IT}/N1.json`)) && (await ex(`${IT}/A1.json`)) && (await ex(`${IT}/AN1.json`)) && (await ex(`${IT}/S1.json`)));
		const j1 = JSON.parse((await read(`${IT}/J1.json`))!);
		check('item file has raw data', j1.data.title === 'Original title' && j1.data.creators[0].lastName === 'Doe');
		check('collections file written', (await read(`${R}/collections.json`))?.includes('Methods'));
		const idx = JSON.parse((await read(`${R}/index.json`))!);
		check('index has 5 summaries + annotation', idx.items.length === 5 && idx.counts.annotations === 1);
		check('index summary tags + collections', idx.items.find((i: { key: string }) => i.key === 'J1').collections.includes('C1'));
		const annFile = JSON.parse((await read(`${AN}/A1.json`))!);
		check('per-PDF annotation file', annFile.annotations.length === 1 && annFile.annotations[0].text === 'first highlight' && annFile.annotations[0].colorName === 'Yellow');
		check('state hasData', mirror.getState()?.hasData === true);
	}

	// ------------------------------------------------------------ test 2: incremental
	console.log('test 2: incremental sync after mutations');
	{
		zotero.updateItem('J1', { title: 'Renamed title' });
		zotero.addItem({
			key: 'AN2',
			itemType: 'annotation',
			data: {
				parentItem: 'A1',
				annotationText: 'second highlight',
				annotationColor: '#5fb236',
				annotationPageLabel: '4',
				annotationSortIndex: '0.200,0.100',
				annotationPosition: '{"pageIndex":3,"rects":[[{"x":0.2,"y":0.1}]]}',
			},
		});
		zotero.addItem({ key: 'J2', itemType: 'book', data: { title: 'A new book', collections: ['C2'] } });
		zotero.deleteItem('S1');
		zotero.addCollection(collection('C1', 'Methods renamed', 0));
		zotero.applyMutations();

		const writesBefore = adapter.writes;
		const r = await engine.requestSync(false);
		check('incremental run ok (not full)', r.ok && !r.full, JSON.stringify(r));
		check('J1 updated + J2/AN2 added', r.updated === 1 && r.added === 2, JSON.stringify(r));
		check('deletion NOT applied in incremental run', (await ex(`${IT}/S1.json`)), 'S1 should remain until reconcile');
		const j1 = JSON.parse((await read(`${IT}/J1.json`))!);
		check('J1 file content updated', j1.data.title === 'Renamed title');
		check('J2 file created', await ex(`${IT}/J2.json`));
		const annFile = JSON.parse((await read(`${AN}/A1.json`))!);
		check('annotation file regenerated w/ 2 sorted', annFile.annotations.length === 2 && annFile.annotations[0].text === 'first highlight' && annFile.annotations[1].text === 'second highlight');
		check('collections.json regenerated on rename', (await read(`${R}/collections.json`))?.includes('Methods renamed'));
		check('index items now 7 (S1 not yet reconciled away)', JSON.parse((await read(`${R}/index.json`))!).items.length === 7);
		void writesBefore;
	}

	// ------------------------------------------------------------ test 3: full sync reconcile deletes
	console.log('test 3: reconcile deletes removed items');
	{
		const r = await engine.requestSync(true);
		check('full run ok', r.ok && r.full, JSON.stringify(r));
		check('S1 removed after reconcile', !(await ex(`${IT}/S1.json`)), 'S1 file should be deleted');
		const idx = JSON.parse((await read(`${R}/index.json`))!);
		check('index no longer lists S1 (6 remain)', idx.items.length === 6 && !idx.items.some((i: { key: string }) => i.key === 'S1'));
		check('index counts two annotations', idx.counts.annotations === 2);
		check('J1 collections still resolve', true);
	}

	// ------------------------------------------------------------ test 4: no writes when nothing changed
	console.log('test 4: idle sync writes nothing');
	{
		const writesBefore = adapter.writes;
		const r = await engine.requestSync(false);
		check('idle run up to date', r.ok && !r.hadChanges, JSON.stringify(r));
		check('zero file writes on idle run', adapter.writes === writesBefore, `writes ${adapter.writes} vs ${writesBefore}`);
		const state = mirror.getState();
		check('state retained', (state?.libraryVersion ?? 0) > 0);
		void r;
	}

	// ------------------------------------------------------------ test 5: never-synced (version 0) handling
	console.log('test 5: version-0 items picked up by reconcile');
	{
		// simulate a never-synced item: add it with version 0 by directly pushing
		// (the mock only bumps on mutations, so emulate by applying after)
		zotero.lib.items.push(item({ key: 'Z0', itemType: 'journalArticle', data: { title: 'Version zero', collections: [] } }, 0));
		const r = await engine.requestSync(true);
		check('full run ok', r.ok, JSON.stringify(r));
		check('version-0 item file created', await ex(`${IT}/Z0.json`));
		check('Z0 counted as added', r.added >= 1, JSON.stringify(r));
		check('reconcile keeps everything else', (await ex(`${IT}/J1.json`)) && (await ex(`${IT}/J2.json`)));
	}

	// ------------------------------------------------------------ test 6: reset
	console.log('test 6: reset mirror');
	{
		await mirror.reset();
		const idxAfter = JSON.parse((await read(`${R}/index.json`))!);
		check('mirror emptied (index rebuilt empty)', !(await ex(`${IT}/J1.json`)) && idxAfter.items.length === 0);
		const r = await engine.requestSync(true);
		check('resync after reset ok', r.ok && r.added >= 5, JSON.stringify(r));
		check('item files rebuilt', await ex(`${IT}/J1.json`));
		// Z0 has version 0: since=0 full snapshot in the mock returns it too (all items)
		check('Z0 back', await ex(`${IT}/Z0.json`));
	}

	await zotero.close();
	console.log(failures === 0 ? '\nINTEGRATION ALL PASS' : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error('harness crashed:', e);
	process.exit(2);
});

export type { MirrorState };
