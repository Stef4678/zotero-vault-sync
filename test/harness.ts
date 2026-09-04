/**
 * Node-side smoke tests for the pure logic: template engine, frontmatter
 * patcher, citation, sanitization, summarization. Run after bundling with
 * `esbuild test/harness.ts` against test/stub-obsidian.ts.
 */
import { parseTemplate, renderTemplate, TemplateScope } from '../src/template';
import { patchFrontmatter, MARK_START, MARK_END } from '../src/notes';
import { creatorsText, htmlToText, itemDisplayTitle, sanitizeFilename, summarizeItem, truncate, yearFromDate } from '../src/util';
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
