/**
 * A line link to a USB serial device through the Web Serial API. Browser-only,
 * and only in Chromium browsers; nothing in `core` touches it.
 */

/** GRBL 1.1 talks at this rate. */
const BAUD_RATE = 115_200;

export type SerialLink = {
	write(data: string): Promise<void>;
	close(): Promise<void>;
};

/** Whether this browser can reach a serial port at all. */
export function serialAvailable(): boolean {
	return typeof navigator !== 'undefined' && navigator.serial !== undefined;
}

/**
 * Asks the operator to choose a port, opens it, and hands every line read
 * from it to `onLine`. `onLost` is called if the device goes away, but not
 * when the link is closed on purpose.
 */
export async function openSerialLink(
	onLine: (line: string) => void,
	onLost: () => void
): Promise<SerialLink> {
	const serial = navigator.serial;
	if (!serial) throw new Error('This browser cannot reach a serial port; use Chrome or Edge');
	const port = await serial.requestPort();
	await port.open({ baudRate: BAUD_RATE });
	const reader = port.readable?.getReader();
	const writer = port.writable?.getWriter();
	if (!reader || !writer) {
		await port.close();
		throw new Error('The port opened but cannot be read and written');
	}

	let open = true;
	const decoder = new TextDecoder();
	void (async () => {
		let buffer = '';
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? '';
				for (const line of lines) if (line.trim()) onLine(line);
			}
		} catch {
			// A device unplugged mid-read ends the loop like any other loss.
		} finally {
			if (open) {
				open = false;
				onLost();
			}
		}
	})();

	return {
		// Each character is one byte: GRBL's real-time commands, such as jog cancel
		// (0x85), are single bytes that UTF-8 would split in two.
		write: (data) => writer.write(Uint8Array.from(data, (char) => char.charCodeAt(0))),
		async close() {
			open = false;
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
			writer.releaseLock();
			await port.close();
		}
	};
}
