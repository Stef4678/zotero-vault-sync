/**
 * Minimal ambient types for the parts of Electron used by this plugin.
 * Obsidian plugins run inside Electron; `electron` is external at bundle time.
 */
declare module 'electron' {
	export const shell: {
		openExternal(url: string): Promise<void> | void;
	};
}
