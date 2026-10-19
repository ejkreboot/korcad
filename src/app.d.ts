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
}

export {};
