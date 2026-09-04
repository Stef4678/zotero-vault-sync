/**
 * Tiny markdown template engine for generated note views.
 *
 * Supported syntax:
 *   {{token}}                    substitute a token value ('' when unknown)
 *   {{#list}}…{{/list}}          render body once per element of `list`
 *   {{?list}}…{{/list}}          render body once, but only when `list` is non-empty
 *
 * Lists nest: an element rendered inside {{#attachments}} may itself provide a
 * nested list `annotations`, giving
 *   {{#attachments}}{{#annotations}}…{{/annotations}}{{/attachments}}
 * Elements carry their own token dictionaries.
 */

export interface TemplateElement {
	tokens: Record<string, string>;
	lists?: Record<string, TemplateElement[]>;
}

export interface TemplateScope {
	tokens: Record<string, string>;
	lists?: Record<string, TemplateElement[]>;
}

export type TemplateNode =
	| { kind: 'text'; text: string }
	| { kind: 'section'; name: string; each: boolean; body: TemplateNode[] }
	| { kind: 'token'; name: string };

const TOKEN_RE = /\{\{([#?/]?)([\w.]+)\}\}/g;

export function parseTemplate(text: string): TemplateNode[] {
	const root: TemplateNode[] = [];
	// stack of section nodes currently open
	const stack: { name: string; node: TemplateNode & { kind: 'section'; body: TemplateNode[] } }[] = [];

	const push = (node: TemplateNode) => {
		const top = stack[stack.length - 1];
		if (top) top.node.body.push(node);
		else root.push(node);
	};

	let lastIndex = 0;
	let m: RegExpExecArray | null;
	TOKEN_RE.lastIndex = 0;
	while ((m = TOKEN_RE.exec(text)) !== null) {
		const full = m[0];
		const prefix = m[1];
		const name = m[2];
		if (m.index > lastIndex) push({ kind: 'text', text: text.slice(lastIndex, m.index) });
		lastIndex = m.index + full.length;

		if (prefix === '#' || prefix === '?') {
			const section: TemplateNode & { kind: 'section'; body: TemplateNode[] } = {
				kind: 'section',
				name,
				each: prefix === '#',
				body: [],
			};
			push(section);
			stack.push({ name, node: section });
		} else if (prefix === '/') {
			const top = stack[stack.length - 1];
			if (top && top.name === name) {
				stack.pop();
			} else {
				push({ kind: 'text', text: full });
			}
		} else {
			push({ kind: 'token', name });
		}
	}
	if (lastIndex < text.length) push({ kind: 'text', text: text.slice(lastIndex) });
	return root;
}

export function renderTemplate(template: string, scope: TemplateScope): string {
	const tree = parseTemplate(template);
	return renderNodes(tree, scope);
}

function renderNodes(nodes: TemplateNode[], scope: TemplateScope): string {
	let out = '';
	for (const n of nodes) {
		if (n.kind === 'text') {
			out += n.text;
		} else if (n.kind === 'token') {
			out += scope.tokens[n.name] ?? '';
		} else {
			const list = scope.lists?.[n.name] ?? [];
			if (n.each) {
				for (const el of list) out += renderNodes(n.body, el);
			} else if (list.length > 0) {
				out += renderNodes(n.body, scope);
			}
		}
	}
	return out;
}

/** Escape markdown table cell content (pipes/newlines). */
export function mdCell(s: string): string {
	return String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}
