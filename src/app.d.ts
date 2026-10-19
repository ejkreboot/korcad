// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/**
	 * The little of the Web Serial API KorCad uses to reach a CNC controller.
	 * TypeScript's DOM library leaves it out, as only Chromium browsers have it,
	 * so `navigator.serial` is optional and must be checked before use.
	 */
	interface SerialPort {
		open(options: { readonly baudRate: number }): Promise<void>;
		close(): Promise<void>;
		readonly readable: ReadableStream<Uint8Array> | null;
		readonly writable: WritableStream<Uint8Array> | null;
	}

	interface Serial {
		requestPort(): Promise<SerialPort>;
	}

	interface Navigator {
		readonly serial?: Serial;
	}

	/**
	 * The file pickers of the File System Access API, which hand back a file
	 * that can be written again in place. Only Chromium browsers have them, so
	 * they are optional and a download stands in elsewhere.
	 */
	type FilePickerType = {
		readonly description: string;
		readonly accept: Readonly<Record<string, readonly string[]>>;
	};

	interface Window {
		showOpenFilePicker?(options?: {
			readonly types?: readonly FilePickerType[];
			readonly multiple?: false;
		}): Promise<FileSystemFileHandle[]>;
		showSaveFilePicker?(options?: {
			readonly suggestedName?: string;
			readonly types?: readonly FilePickerType[];
		}): Promise<FileSystemFileHandle>;
	}
}

export {};
