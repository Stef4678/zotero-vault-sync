/**
 * Generated "Dataview views": markdown dashboard notes containing dataviewjs
 * queries that render live over the mirror JSON. They are written by the
 * plugin (automatically after the first mirror, or via command) and can be
 * regenerated at any time.
 *
 * Query-technique note (verified against Dataview's source): dataviewjs has no
 * `dv.io.loadJson`, and `dv.io.load` only reads files Obsidian has indexed —
 * unreliable for mirror files written straight to disk. Dataview *does* expose
 * `dv.app`, so every generated query reads JSON through
 * `dv.app.vault.adapter.read()`, which works for any path, any extension,
 * hidden dot-folders included.
 */

export const VIEW_MARKER = '<!-- zotero-views:generated -->';

export interface DataviewViewFile {
	name: string;
	content: string;
}

function loaderJs(mirrorFolder: string): string {
	const mirror = JSON.stringify(mirrorFolder);
	return [
		`const MIRROR = ${mirror};`,
		`async function readJson(p) {`,
		`  try { return JSON.parse(await dv.app.vault.adapter.read(p)); }`,
		`  catch (e) {`,
		`    try { const t = await dv.io.load(p); return t ? JSON.parse(t) : null; }`,
		`    catch (e2) { return null; }`,
		`  }`,
		`}`,
	].join('\n');
}

function file(kind: string, bodyJs: string): string {
	return [
		`# ${kind}`,
		'',
		`> Live view over the Zotero mirror. Requires the **Dataview** community plugin.`,
		`> Regenerate any time with *Zotero Vault Sync → Create/refresh Dataview views*.`,
		`> Customized? Delete the marker comment below — refreshes then skip this file.`,
		'',
		VIEW_MARKER,
		'',
		'```dataviewjs',
		bodyJs,
		'```',
		'',
	].join('\n');
}

export function buildViewFiles(mirrorFolder: string): DataviewViewFile[] {
	return [
		{
			name: 'Zotero Items.md',
			content: file('Zotero items', itemsView(mirrorFolder)),
		},
		{
			name: 'Zotero PDFs & Annotations.md',
			content: file('Zotero PDFs & annotations', pdfsView(mirrorFolder)),
		},
		{
			name: 'Zotero Library Stats.md',
			content: file('Zotero library stats', statsView(mirrorFolder)),
		},
	];
}

function itemsView(mirrorFolder: string): string {
	const L = loaderJs(mirrorFolder);
	return [
		L,
		'',
		`const idx = await readJson(MIRROR + "/index.json");`,
		`if (!idx || !Array.isArray(idx.items)) {`,
		`  dv.paragraph("No mirror data yet — run the command \\"Zotero Vault Sync: Sync now\\" first.");`,
		`} else {`,
		`  const notes = (await readJson(MIRROR + "/notes.json")) || {};`,
		`  const collName = {};`,
		`  for (const c of (await readJson(MIRROR + "/collections.json")) || []) collName[c.key] = c.name;`,
		`  const tops = idx.items.filter(function (i) { return !i.parentItem && i.itemType !== "attachment"; });`,
		`  tops.sort(function (a, b) { return String(a.title || a.key).localeCompare(String(b.title || b.key)); });`,
		`  const rows = [];`,
		`  for (const it of tops) {`,
		`    const notePath = notes[it.key];`,
		`    const title = notePath ? dv.fileLink(notePath, false, it.title || it.key) : (it.title || it.key);`,
		`    const colls = (it.collections || []).map(function (k) { return collName[k] || k; }).join(", ");`,
		`    const raw = dv.fileLink(MIRROR + "/items/" + it.key + ".json", false, "JSON");`,
		`    rows.push([title, it.creators || "", it.year || "", it.itemType, colls, raw]);`,
		`  }`,
		`  dv.table(["Title (note)", "Creators", "Year", "Type", "Collections", "Mirror"], rows);`,
		`}`,
	].join('\n');
}

function pdfsView(mirrorFolder: string): string {
	const L = loaderJs(mirrorFolder);
	return [
		L,
		'',
		`const idx = await readJson(MIRROR + "/index.json");`,
		`if (!idx || !Array.isArray(idx.items)) {`,
		`  dv.paragraph("No mirror data yet — run the command \\"Zotero Vault Sync: Sync now\\" first.");`,
		`} else {`,
		`  const pdfs = idx.items.filter(function (i) { return i.itemType === "attachment"; });`,
		`  const owner = {};`,
		`  for (const it of idx.items) {`,
		`    if (!it.parentItem && it.itemType !== "attachment") owner[it.key] = it.title || it.key;`,
		`  }`,
		`  const rows = [];`,
		`  let total = 0;`,
		`  for (const pdf of pdfs) {`,
		`    const ann = await readJson(MIRROR + "/annotations/" + pdf.key + ".json");`,
		`    const list = (ann && Array.isArray(ann.annotations)) ? ann.annotations : [];`,
		`    total += list.length;`,
		`    const name = pdf.title || pdf.key;`,
		`    if (!list.length) {`,
		`      rows.push([name, owner[pdf.parentItem] || "", "", "", "—", ""]);`,
		`    } else {`,
		`      for (const a of list) {`,
		`        rows.push([name, owner[pdf.parentItem] || "", a.pageLabel || "", a.colorName || a.color || "", a.text || "", a.comment || ""]);`,
		`      }`,
		`    }`,
		`  }`,
		`  dv.paragraph("**" + pdfs.length + " PDF attachments · " + total + " annotations**");`,
		`  dv.table(["PDF", "Belongs to", "Page", "Color", "Highlight", "Comment"], rows);`,
		`}`,
	].join('\n');
}

function statsView(mirrorFolder: string): string {
	const L = loaderJs(mirrorFolder);
	return [
		L,
		'',
		`const idx = await readJson(MIRROR + "/index.json");`,
		`if (!idx || !idx.counts) {`,
		`  dv.paragraph("No mirror data yet — run the command \\"Zotero Vault Sync: Sync now\\" first.");`,
		`} else {`,
		`  const c = idx.counts;`,
		`  dv.header(3, "Mirror snapshot");`,
		`  dv.list([`,
		`    "Mirrored items: " + c.items,`,
		`    "Top-level items: " + c.topLevel,`,
		`    "PDF attachments: " + c.attachments,`,
		`    "Annotations: " + c.annotations,`,
		`    "Notes: " + c.notes,`,
		`    "Index generated: " + (idx.generatedAt || "?")`,
		`  ]);`,
		`  const tops = idx.items.filter(function (i) { return !i.parentItem && i.itemType !== "attachment"; });`,
		`  const byType = {};`,
		`  for (const it of tops) byType[it.itemType] = (byType[it.itemType] || 0) + 1;`,
		`  const typeRows = Object.keys(byType).map(function (t) { return [t, byType[t]]; })`,
		`    .sort(function (a, b) { return b[1] - a[1]; });`,
		`  dv.header(3, "Top-level items by type");`,
		`  dv.table(["Type", "Count"], typeRows);`,
		`  const tagCount = {};`,
		`  for (const it of idx.items) {`,
		`    for (const t of (it.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1;`,
		`  }`,
		`  const tagRows = Object.keys(tagCount).map(function (t) { return [t, tagCount[t]]; })`,
		`    .sort(function (a, b) { return b[1] - a[1]; })`,
		`    .slice(0, 15);`,
		`  dv.header(3, "Most-used tags");`,
		`  dv.table(["Tag", "Items"], tagRows);`,
		`}`,
	].join('\n');
}
