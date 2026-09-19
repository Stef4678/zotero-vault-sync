/**
 * Node-side smoke tests for the pure logic: template engine, frontmatter
 * patcher, citation, sanitization, summarization. Run after bundling with
 * `esbuild test/harness.ts` against test/stub-obsidian.ts.
 */
import { parseTemplate, renderTemplate, TemplateScope } from '../src/template';
import { App } from 'obsidian';
import { patchFrontmatter, MARK_START, MARK_END, DEFAULT_TEMPLATE, NotesEngine } from '../src/notes';
import {
	creatorsText,
	htmlToText,
	itemDisplayTitle,
	sanitizeFilename,
	summarizeItem,
	truncate,
	yearFromDate,
	zoteroItemLink,
	zoteroItemUri,
} from '../src/util';
import { referenceCard } from '../src/itemPicker';
import { ItemSummary } from '../src/types';
import { naiveCitation } from '../src/notes';
import { ZoteroItem } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings';

let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
	}
}

const managed = {
	zoteroKey: 'ABC123DE',
	mirror: true,
	itemType: 'journalArticle',
	title: 'A "tricky" title: with {colons}',
	updated: '2026-01-02T03:04:05.000Z',
	tags: ['methods', 'quant review'],
};

// ---------------------------------------------------------------- template
console.log('template engine');
{
	const scope: TemplateScope = {
		tokens: { title: 'Hello', empty: '' },
		lists: {
			attachments: [
				{
					tokens: { filename: 'a.pdf' },
					lists: {
						annotations: [
							{ tokens: { text: 'one', page: '3' } },
							{ tokens: { text: 'two', page: '4' } },
						],
						annotationsEmpty: [],
					},
				},
				{ tokens: { filename: 'b.pdf' }, lists: { annotations: [], annotationsEmpty: [{ tokens: {} }] } },
			],
			none: [],
		},
	};
	const tpl =
		'# {{title}}{{#unknown}}{{/unknown}}\n' +
		'{{?none}}SHOULD NOT APPEAR{{/none}}\n' +
		'{{#attachments}}\n' +
		'## {{filename}}\n' +
		'{{#annotations}}- {{text}} p{{page}}{{/annotations}}\n' +
		'{{#annotationsEmpty}}_none_{{/annotationsEmpty}}\n' +
		'{{/attachments}}\n' +
		'tail {{missing}}';
	const out = renderTemplate(tpl, scope);
	check('tokens substituted', out.includes('# Hello'));
	check('empty ?-section suppressed', !out.includes('SHOULD NOT APPEAR'));
	check('nested section per attachment 1', out.includes('## a.pdf') && out.includes('- one p3') && out.includes('- two p4'));
	check('nested section per attachment 2 + empty alt', out.includes('## b.pdf') && out.includes('_none_'));
	check('only 2 attachment headers', (out.match(/## [ab]\.pdf/g) || []).length === 2);
	check('unknown token removed', !out.includes('{{missing}}') && out.includes('tail '));
	const tree = parseTemplate('{{#a}}{{#b}}x{{/b}}{{/a}}');
	check('parser nests cleanly', tree.length === 1);
}

// ---------------------------------------------------------------- frontmatter
console.log('frontmatter patcher');
{
	const mdWithUser = `---
tags:
  - "keepme"
custom: 123
zotero-key: "OLDKEY"
title: "Old Title"
rating: 5
---
Body content {{x}}
`;
	const patched = patchFrontmatter(mdWithUser, managed);
	check('managed key replaced', patched.includes('zotero-key: "ABC123DE"'));
	check('managed tags list written', patched.includes('  - "methods"') && patched.includes('  - "quant review"'));
	check('user tags removed (managed key)', !patched.includes('keepme'));
	check('user yaml preserved', patched.includes('custom: 123') && patched.includes('rating: 5'));
	check('title escaped for yaml', patched.includes('title: "A \\"tricky\\" title: with {colons}"'));
	check('body preserved', patched.includes('Body content {{x}}'));
	check('no duplicated closing', (patched.match(/^---$/gm) || []).length === 2);

	const noFm = patchFrontmatter('# Just a title\n\nhello world', managed);
	check('fm added when absent', noFm.startsWith('---\n') && noFm.includes('hello world'));

	const broken = patchFrontmatter('---\norphan: yaml\nnever closed', managed);
	check('unterminated fm does not eat content', broken.includes('never closed'));

	const fmOnly = '---\nzotero-key: "A"\nzotero-mirror: true\n---\n';
	const patched2 = patchFrontmatter(fmOnly, managed);
	check('fm-only file patched', patched2.includes('zotero-key: "ABC123DE"'));
}

// ---------------------------------------------------------------- markers
console.log('markers');
{
	check('marker constants differ', MARK_START !== MARK_END);
}

// ---------------------------------------------------------------- util
console.log('util');
{
	check('sanitize removes illegal chars', sanitizeFilename('a/b:c*d?e"f<g>h|i') === 'a b c d e f g h i');
	check('sanitize trims trailing dots', !sanitizeFilename('paper...').endsWith('.'));
	check('year extracted', yearFromDate('2021-03-04') === '2021');
	check('html stripped', htmlToText('<p>Hello &amp; <b>world</b></p>') === 'Hello & world');
	check('truncate zero = full', truncate('x'.repeat(10), 0) === 'x'.repeat(10));
	check('truncate short keeps <= n chars', truncate('abcdef', 4) === 'abc…' && truncate('abcdef', 4).length === 4);
	const creators = [
		{ creatorType: 'author', lastName: 'Doe', firstName: 'Jane' },
		{ creatorType: 'author', name: 'ACME Labs' },
	];
	check('creators text', creatorsText(creators) === 'Doe, Jane; ACME Labs');
	const rec: ZoteroItem = {
		key: 'K1',
		version: 7,
		data: {
			key: 'K1',
			version: 7,
			itemType: 'attachment',
			filename: 'paper.pdf',
			title: 'paper.pdf',
			parentItem: 'P1',
			contentType: 'application/pdf',
			collections: [],
			tags: [],
			relations: {},
		},
	};
	check('attachment title = filename', itemDisplayTitle(rec.data) === 'paper.pdf');
	const s = summarizeItem(rec);
	check('summary keyed', s.key === 'K1' && s.itemType === 'attachment' && s.parentItem === 'P1');
}

// ---------------------------------------------------------------- zotero links
console.log('zotero:// links');
{
	// Regression: the legacy `zotero://select/items/<key>` route is not recognised
	// by current Zotero — it launches the app but selects nothing. Only
	// `select/library/items/<key>` actually selects the item.
	check('item URI uses the select/library route', zoteroItemUri('ABC123DE') === 'zotero://select/library/items/ABC123DE');
	check('no legacy select/items route', !zoteroItemUri('ABC123DE').includes('select/items/'));
	check('item link is a markdown link', zoteroItemLink('ABC123DE') === '[ABC123DE](zotero://select/library/items/ABC123DE)');

	const summary: ItemSummary = {
		key: 'ABC123DE',
		version: 3,
		itemType: 'journalArticle',
		title: 'A study',
		creators: 'Doe, Jane',
		year: '2020',
		date: '2020-05-01',
		parentItem: null,
		collections: [],
		tags: ['methods'],
	};
	const card = referenceCard(summary, DEFAULT_SETTINGS);
	check('reference card links with the working URI', card.includes('[Zotero](zotero://select/library/items/ABC123DE)'));
	check('reference card has no legacy URI', !card.includes('zotero://select/items/'));

	// Regression: the token is already a markdown link, so the default template
	// must interpolate it bare — wrapping it in `[Open in Zotero](…)` produced the
	// malformed target `]([KEY](zotero://…))`, which is not a clickable link.
	const rendered = renderTemplate(DEFAULT_TEMPLATE, {
		tokens: {
			title: 'A study',
			zoteroLink: zoteroItemLink('ABC123DE'),
			mirrorLink: '[[_zotero/items/ABC123DE.json|item JSON]]',
		},
	});
	check('default template keeps the Zotero link well-formed', rendered.includes('](zotero://select/library/items/ABC123DE)'));
	check('default template does not nest link syntax', !rendered.includes('](['));
	check('default template still shows the item key', rendered.includes('[ABC123DE](zotero://select/library/items/ABC123DE)'));
}

// ---------------------------------------------------------------- citation
console.log('citation');
{
	const rec: ZoteroItem = {
		key: 'C1',
		version: 1,
		data: {
			key: 'C1',
			version: 1,
			itemType: 'journalArticle',
			creators: [
				{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' },
				{ creatorType: 'author', firstName: 'John', lastName: 'Smith' },
			],
			title: 'A study',
			date: '2020-05-01',
			publicationTitle: 'Journal of Things',
			volume: '12',
			issue: '3',
			pages: '10-20',
			DOI: '10.1/abc',
			collections: [],
			tags: [],
			relations: {},
		},
	};
	const cite = naiveCitation(rec, undefined, DEFAULT_SETTINGS);
	check('citation has authors + year + doi', cite.includes('Doe') && cite.includes('(2020)') && cite.includes('doi.org/10.1/abc'));
	check('citation has volume issue pages', cite.includes('12') && cite.includes('(3)') && cite.includes('10-20'));
}

// ------------------------------------------------- generated note body (async)
// Regression: includeAnnotations used to be a dead setting — the toggle wrote it,
// nothing read it, and highlights appeared regardless. It must now gate the
// annotation list, and excluding annotations must not print the "no annotations"
// placeholder either.
void (async () => {
	console.log('generated note body');
	const attachment: ZoteroItem = {
		key: 'ATT00001',
		version: 1,
		data: {
			key: 'ATT00001',
			version: 1,
			itemType: 'attachment',
			filename: 'paper.pdf',
			contentType: 'application/pdf',
			parentItem: 'ABC123DE',
			collections: [],
			tags: [],
			relations: {},
		},
	};
	const annotation: ZoteroItem = {
		key: 'ANN00001',
		version: 1,
		data: {
			key: 'ANN00001',
			version: 1,
			itemType: 'annotation',
			parentItem: 'ATT00001',
			annotationText: 'A highlighted sentence',
			annotationComment: 'my comment',
			annotationColor: '#ffd400',
			annotationPageLabel: '3',
			collections: [],
			tags: [],
			relations: {},
		},
	};
	const fakeMirror = {
		childRecords: async (key: string) =>
			key === 'ABC123DE' ? [{ item: attachment }] : key === 'ATT00001' ? [{ item: annotation }] : [],
		collectionName: (_key: string) => null,
	};
	const record: ZoteroItem = {
		key: 'ABC123DE',
		version: 3,
		data: {
			key: 'ABC123DE',
			version: 3,
			itemType: 'journalArticle',
			title: 'A study',
			creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
			date: '2020-05-01',
			collections: [],
			tags: [],
			relations: {},
		},
	};
	const summary: ItemSummary = {
		key: 'ABC123DE',
		version: 3,
		itemType: 'journalArticle',
		title: 'A study',
		creators: 'Doe, Jane',
		year: '2020',
		date: '2020-05-01',
		parentItem: null,
		collections: [],
		tags: [],
	};
	const render = (settings: typeof DEFAULT_SETTINGS): Promise<string> => {
		const e = new NotesEngine(new App() as never, fakeMirror as never, () => settings);
		return (e as unknown as { renderBody(s: ItemSummary, r: ZoteroItem): Promise<string> }).renderBody(
			summary,
			record
		);
	};


	const withAnn = await render({ ...DEFAULT_SETTINGS, includeAttachments: true, includeAnnotations: true });
	check('annotations rendered when enabled', withAnn.includes('A highlighted sentence') && withAnn.includes('paper.pdf'));

	const withoutAnn = await render({ ...DEFAULT_SETTINGS, includeAttachments: true, includeAnnotations: false });
	check('annotations omitted when disabled', !withoutAnn.includes('A highlighted sentence'));
	check('no empty-annotations placeholder when disabled', !withoutAnn.includes('No annotations'));
	check('attachment section still rendered when annotations disabled', withoutAnn.includes('paper.pdf'));

	const noAttachments = await render({ ...DEFAULT_SETTINGS, includeAttachments: false, includeAnnotations: true });
	check('attachments omitted when disabled', !noAttachments.includes('paper.pdf') && !noAttachments.includes('A highlighted sentence'));

	console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
})();
