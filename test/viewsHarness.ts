/**
 * Validates the generated Dataview views: extracts each embedded dataviewjs
 * block from the files produced by buildViewFiles() and executes it in Node
 * against an in-memory fake vault + mock `dv`, asserting the rendered tables.
 */
import { buildViewFiles, VIEW_MARKER } from '../src/views';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
	}
}

// ---------------------------------------------------------------- sample mirror
const files = new Map<string, string>();
const put = (p: string, o: unknown) => files.set(p, JSON.stringify(o));

put('_zotero/index.json', {
	schema: 1,
	source: { type: 'local', label: 'sid:x' },
	generatedAt: '2026-01-01T00:00:00.000Z',
	libraryVersion: 9,
	counts: { items: 4, attachments: 1, annotations: 1, notes: 1, topLevel: 2 },
	items: [
		{ key: 'J1', version: 5, itemType: 'journalArticle', title: 'Alpha Study', creators: 'Doe, Jane', year: '2020', date: '2020-06-01', parentItem: null, collections: ['C1'], tags: ['methods'] },
		{ key: 'S1', version: 2, itemType: 'note', title: null, creators: null, year: null, date: null, parentItem: null, collections: [], tags: ['scratch'] },
		{ key: 'A1', version: 3, itemType: 'attachment', title: 'alpha.pdf', creators: null, year: null, date: null, parentItem: 'J1', collections: [], tags: [] },
		{ key: 'AN1', version: 4, itemType: 'annotation', title: null, creators: null, year: null, date: null, parentItem: 'A1', collections: [], tags: [] },
	],
});
put('_zotero/collections.json', [{ key: 'C1', version: 1, name: 'Reading List', parentCollection: false }]);
put('_zotero/notes.json', { J1: 'Zotero Notes/Alpha Study.md' });
put('_zotero/annotations/A1.json', {
	attachmentKey: 'A1',
	parentItemKey: 'J1',
	libraryVersion: 9,
	filename: 'alpha.pdf',
	generatedAt: '2026-01-01T00:00:00.000Z',
	annotations: [
		{ key: 'AN1', version: 4, color: '#ffd400', colorName: 'Yellow', pageLabel: '3', pageIndex: 2, text: 'first highlight', comment: 'remember this', sortIndex: '0.1,0.2', sortPosition: [0.1, 0.2], position: null, dateModified: null },
	],
});

function makeDv() {
	const calls: { kind: string; args: unknown[] }[] = [];
	const dv = {
		calls,
		app: {
			vault: {
				adapter: {
					async read(p: string): Promise<string> {
						const v = files.get(p);
						if (v === undefined) throw new Error(`no such file ${p}`);
						return v;
					},
				},
			},
		},
		io: {
			async load(): Promise<string | undefined> {
				return undefined; // simulate a file Obsidian has not indexed
			},
		},
		paragraph(text: unknown) {
			calls.push({ kind: 'paragraph', args: [text] });
		},
		header(level: number, text: unknown) {
			calls.push({ kind: 'header', args: [level, text] });
		},
		list(values: unknown) {
			calls.push({ kind: 'list', args: [values] });
		},
		table(headers: string[], rows: unknown[]) {
			calls.push({ kind: 'table', args: [headers, rows] });
		},
		fileLink(path: string | undefined, _embed: boolean, display?: string) {
			return display ?? path ?? '';
		},
	};
	return dv as unknown as Record<string, unknown> & { calls: typeof calls };
}

async function runView(body: string, dv: ReturnType<typeof makeDv>): Promise<void> {
	// new Function only returns the value of an explicit `return` — wrap the
	// async IIFE accordingly, otherwise `await` would see `undefined`.
	const src = `return (async () => {\n${body}\n})();`;
	const fn = new Function('dv', src);
	await fn(dv);
}

async function main(): Promise<void> {
	const filesBuilt = buildViewFiles('_zotero');
	check('three view files generated', filesBuilt.length === 3 && filesBuilt.every((f) => f.content.includes(VIEW_MARKER)));

	const byName = new Map(filesBuilt.map((f) => [f.name, f.content]));
	const itemsFile = byName.get('Zotero Items.md')!;
	const pdfFile = byName.get('Zotero PDFs & Annotations.md')!;
	const statsFile = byName.get('Zotero Library Stats.md')!;

	const extract = (content: string): string => {
		const m = /```dataviewjs\n([\s\S]*?)\n```/.exec(content);
		if (!m) throw new Error('no dataviewjs block found');
		return m[1];
	};

	// 1) items view
	{
		const dv = makeDv();
		await runView(extract(itemsFile), dv);
		const tables = dv.calls.filter((c) => c.kind === 'table');
		check('items view renders one table', tables.length === 1);
		const [headers, rows] = tables[0].args as [string[], (string | number)[][]];
		check('items headers', headers.join('|') === 'Title (note)|Creators|Year|Type|Collections|Mirror');
		check('items rows = 2 top-level', rows.length === 2, JSON.stringify(rows));
		check('J1 links to its note', rows[0][0] === 'Alpha Study');
		check('J1 collections resolved by name', rows[0][4] === 'Reading List');
		check('note falls back to key', rows[1][0] === 'S1');
	}

	// 2) pdfs view
	{
		const dv = makeDv();
		await runView(extract(pdfFile), dv);
		const tables = dv.calls.filter((c) => c.kind === 'table');
		check('pdfs view renders one table', tables.length === 1);
		const [headers, rows] = tables[0].args as [string[], (string | number)[][]];
		check('pdfs headers', headers.join('|') === 'PDF|Belongs to|Page|Color|Highlight|Comment');
		check('one annotation row', rows.length === 1, JSON.stringify(rows));
		check('annotation fields mapped', rows[0][0] === 'alpha.pdf' && rows[0][1] === 'Alpha Study' && rows[0][2] === '3' && rows[0][3] === 'Yellow' && rows[0][4] === 'first highlight' && rows[0][5] === 'remember this', JSON.stringify(rows[0]));
	}

	// 3) stats view
	{
		const dv = makeDv();
		await runView(extract(statsFile), dv);
		const lists = dv.calls.filter((c) => c.kind === 'list');
		const tables = dv.calls.filter((c) => c.kind === 'table');
		check('stats view has a list + 2 tables', lists.length === 1 && tables.length === 2, JSON.stringify(dv.calls.map((c) => c.kind)));
		const listText = lists[0].args[0] as string[];
		check('snapshot counts present', listText.join('\n').includes('Mirrored items: 4') && listText.join('\n').includes('Annotations: 1'));
		const [h1, r1] = tables[0].args as [string[], (string | number)[][]];
		check('type table sorted desc', h1[0] === 'Type' && r1[0][0] === 'journalArticle' && r1[0][1] === 1, JSON.stringify(r1));
	}

	// 4) empty mirror handling does not crash
	{
		files.clear();
		const dv = makeDv();
		await runView(extract(itemsFile), dv);
		const paras = dv.calls.filter((c) => c.kind === 'paragraph');
		check('missing index shows friendly paragraph', paras.length === 1 && String(paras[0].args[0]).includes('No mirror data'));
	}

	console.log(failures === 0 ? '\nVIEWS ALL PASS' : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error('views harness crashed:', e);
	process.exit(2);
});
