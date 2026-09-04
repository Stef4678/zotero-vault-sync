/**
 * Minimal stand-in for the `obsidian` module so the mirror + sync engine can be
 * bundled and exercised in plain Node against a mock Zotero server.
 * Only names that the imported source modules actually use at runtime exist.
 */

export class App {}

export class TFile {
	path = '';
}

export class Vault {}

export function normalizePath(p: string): string {
	if (!p) return p;
	return p
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

interface UrlLike {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

/** requestUrl replacement: real HTTP GET via fetch. */
export async function requestUrl(req: UrlLike | string): Promise<{
	status: number;
	headers: Record<string, string>;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
}> {
	const url = typeof req === 'string' ? req : req.url;
	const method = typeof req === 'string' ? 'GET' : req.method ?? 'GET';
	const headers: Record<string, string> = {
		Accept: 'application/json',
		...(typeof req === 'string' ? {} : req.headers ?? {}),
	};
	const res = await fetch(url, { method, headers });
	const text = await res.text();
	const outHeaders: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		outHeaders[k] = v;
	});
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	if (res.status >= 400) {
		const e = new Error(`Request failed: ${res.status}`) as Error & { status: number };
		e.status = res.status;
		throw e;
	}
	return { status: res.status, headers: outHeaders, json, text, arrayBuffer: new ArrayBuffer(0) };
}
