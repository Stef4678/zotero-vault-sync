/**
 * LIVE validation against the real Zotero local API on this machine
 * (read-only for Zotero; the mirror is written into a scratch folder inside
 * the workspace). Verifies the Node-http transport, full snapshot, version-0
 * item coverage and idle no-write behavior against the actual server.
 */
import { Mirror } from '../src/mirror';
import { SyncEngine } from '../src/sync';
import { ZoteroClient } from '../src/api';
import { ZoteroMirrorSettings, DEFAULT_SETTINGS } from '../src/settings';
import { isoNow } from '../src/util';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
	}
}

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

async function main(): Promise<void> {
	const settings: ZoteroMirrorSettings = {
		...DEFAULT_SETTINGS,
		source: 'local',
		localApiUrl: 'http://127.0.0.1:23119/api/users/0',
		mirrorFolder: '_zotero-live-test',
		reconcileMinutes: 1,
		pollIntervalSeconds: 0,
	};
	const adapter = new MemAdapter();
	const vault = { adapter } as unknown as import('obsidian').Vault;
	const mirror = new Mirror(vault, () => settings);
	const client = new ZoteroClient(() => settings);
	const engine = new SyncEngine(mirror, client, () => settings, {
		onStatus: () => undefined,
		onAlert: (m) => console.log('  alert:', m),
	});

	const R = settings.mirrorFolder;
	const read = (p: string) => adapter.files.get(p);
	const ex = async (p: string) => adapter.exists(p);

	console.log('ping:');
	const ping = await client.ping();
	console.log('  ', JSON.stringify(ping));
	check('ping ok via node transport', ping.ok, ping.message);

	console.log('first sync (full):');
	const t0 = Date.now();
	const r1 = await engine.requestSync(false);
	console.log('  ', JSON.stringify({ ...r1, ms: Date.now() - t0 }));
	check('first run ok + full', r1.ok && r1.full, JSON.stringify(r1));
	check('mirrored something', r1.added > 0);

	const idx = JSON.parse((await read(`${R}/index.json`))!);
	console.log('  index:', JSON.stringify(idx.counts));

	// parity with the server's own item count (catches version-0 exclusions)
	const versions = await client.fetchItemVersions();
	check('item file parity with server keys', versions.size === idx.items.length, `server=${versions.size} mirror=${idx.items.length}`);

	const annDirFiles = [...adapter.files.keys()].filter((f) => f.startsWith(`${R}/annotations/`));
	console.log(`  annotation files: ${annDirFiles.length}`);
	check('collections mirrored', (await read(`${R}/collections.json`)) !== undefined);
	check('state persisted', (await ex(`${R}/.state.json`)));

	if (annDirFiles.length) {
		const one = annDirFiles[0];
		const ann = JSON.parse((await read(one))!);
		check('annotation file has header fields', ann.attachmentKey && typeof ann.annotations.length === 'number');
		console.log(`  sample ${one}: ${ann.annotations.length} annotations`);
	}

	console.log('idle sync (no writes expected):');
	const writesBefore = adapter.writes;
	const r2 = await engine.requestSync(false);
	console.log('  ', JSON.stringify(r2));
	check('idle run reports up to date', r2.ok && !r2.hadChanges, JSON.stringify(r2));
	check('no file writes on idle run', adapter.writes === writesBefore, `writes ${adapter.writes} vs ${writesBefore}`);

	console.log(failures === 0 ? '\nLIVE ALL PASS' : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error('live harness crashed:', e);
	process.exit(2);
});

export {};
