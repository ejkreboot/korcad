import { download } from './persistence.js';

/**
 * Opening and saving small JSON files the operator keeps, such as a material
 * preset. Where the browser has the File System Access pickers, a file opened
 * or saved once can be saved again in place, so Save means what it says;
 * elsewhere a file input reads and a download writes, and the browser decides
 * where the download goes.
 */

export type TextFileKind = {
	/** What the picker calls these files. */
	readonly description: string;
	/** The ending a saved file's name is given, such as `.korcad-material.json`. */
	readonly suffix: string;
};

/** A file this session can write again without asking where, when the browser allows it. */
export type SavedFile = {
	readonly name: string;
	readonly handle: FileSystemFileHandle | null;
};

/** A file the editor holds settings from, with what it held when last opened or saved. */
export type LinkedFile<T> = SavedFile & { readonly saved: T };

const pickerTypes = (kind: TextFileKind) => [
	{ description: kind.description, accept: { 'application/json': ['.json'] } }
];

/** The picker was closed without a file chosen, which is not an error. */
const cancelled = (reason: unknown) =>
	reason instanceof DOMException && reason.name === 'AbortError';

/** A name ending in the kind's suffix, so the file says what it holds. */
export function fileNameFor(stem: string, kind: TextFileKind): string {
	return stem.endsWith(kind.suffix) ? stem : `${stem}${kind.suffix}`;
}

/** A file's name without the kind's suffix, or without `.json`, for a short label. */
export function fileStem(name: string, kind: TextFileKind): string {
	if (name.endsWith(kind.suffix)) return name.slice(0, -kind.suffix.length);
	return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

/** Asks for a file and reads it, or resolves `null` when the operator chooses none. */
export async function openTextFile(
	kind: TextFileKind
): Promise<(SavedFile & { readonly text: string }) | null> {
	if (window.showOpenFilePicker) {
		try {
			const [handle] = await window.showOpenFilePicker({ types: pickerTypes(kind) });
			if (!handle) return null;
			const file = await handle.getFile();
			return { name: file.name, handle, text: await file.text() };
		} catch (reason) {
			if (cancelled(reason)) return null;
			throw reason;
		}
	}
	const file = await chooseFile();
	return file ? { name: file.name, handle: null, text: await file.text() } : null;
}

function chooseFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.hidden = true;
		const finish = (file: File | null) => {
			input.remove();
			resolve(file);
		};
		input.addEventListener('change', () => finish(input.files?.[0] ?? null));
		input.addEventListener('cancel', () => finish(null));
		document.body.append(input);
		input.click();
	});
}

/**
 * Writes `text` back to `target` when this session can write that file in
 * place. Otherwise, or for Save as, it asks where: the browser's picker where
 * there is one, else a name for the download. Resolves to the file written, or
 * `null` when the operator backs out.
 */
export async function saveTextFile(
	text: string,
	target: SavedFile,
	kind: TextFileKind,
	saveAs: boolean
): Promise<SavedFile | null> {
	try {
		let handle = saveAs ? null : target.handle;
		if (!handle && window.showSaveFilePicker) {
			handle = await window.showSaveFilePicker({
				suggestedName: target.name,
				types: pickerTypes(kind)
			});
		}
		if (handle) {
			const writable = await handle.createWritable();
			await writable.write(text);
			await writable.close();
			return { name: handle.name, handle };
		}
		let name = target.name;
		if (saveAs) {
			const typed = prompt(`Save ${kind.description.toLowerCase()} as`, fileStem(name, kind));
			if (typed === null || typed.trim() === '') return null;
			name = fileNameFor(typed.trim(), kind);
		}
		download(name, text, 'application/json');
		return { name, handle: null };
	} catch (reason) {
		if (cancelled(reason)) return null;
		throw reason;
	}
}
