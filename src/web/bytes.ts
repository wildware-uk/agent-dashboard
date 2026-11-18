/**
 * One file, over the wire, with the sender able to watch it go.
 *
 * `fetch` cannot report upload progress. It resolves when the *response*
 * starts, and there is no event in between, so a 400MB file is indistinguishable
 * from a hung one: the box shows a dimmed thumbnail and nothing else happens for
 * a minute. `XMLHttpRequest` does have the event — `xhr.upload.onprogress` —
 * which is the whole reason this file exists next to a perfectly good `fetch`
 * everywhere else in `./actions.ts`.
 *
 * Streaming request bodies (`duplex: 'half'`) would be the modern answer, but
 * they are Chromium-only, require HTTP/2, and still report only what the page
 * has handed the network stack rather than what has left it. XHR is the boring
 * one that works in every browser the owner might open this in.
 *
 * The response is handed back as data — status, ok, parsed body — so this knows
 * nothing about `ActionError`. Turning a status into a message is `./actions.ts`'s
 * job, and it already does it for every other route.
 */

/** A finished request, whatever it answered. */
export type ByteOutcome = {
	status: number;
	ok: boolean;
	/** The JSON body, or `null` when the answer was not JSON at all. */
	body: Record<string, unknown> | null;
};

/**
 * How far along one upload is.
 *
 * `total` is `null` when the browser cannot say — a body of unknown length —
 * which is why callers must cope with a count that has nothing to divide by.
 */
export type UploadProgress = (sent: number, total: number | null) => void;

/** How an `XMLHttpRequest` is made. Injectable, so this is testable in node. */
export type XhrFactory = () => XMLHttpRequest;

/** Thrown when the request never landed: no status, nothing to read. */
export class UploadUnreachable extends Error {
	constructor() {
		super('the upload never reached the server');
		this.name = 'UploadUnreachable';
	}
}

/** Whether this environment can report progress at all. */
export function canReportProgress(): boolean {
	return typeof XMLHttpRequest === 'function';
}

export type PutBytesInput = {
	url: string;
	/** The bytes. Sent as the whole body — no multipart wrapper. */
	file: Blob;
	/** What to declare. The server checks the bytes against it. */
	contentType: string;
	/** Called as the bytes leave, and once more when they all have. */
	onProgress?: UploadProgress;
	make?: XhrFactory;
};

/**
 * POST one file, reporting progress as it goes.
 *
 * Resolves for any answer with a status, including a refusal — a 413 is an
 * answer, and the caller needs to read it. Rejects with {@link UploadUnreachable}
 * only when there is no answer at all.
 */
export function putBytes(input: PutBytesInput): Promise<ByteOutcome> {
	const make = input.make ?? (() => new XMLHttpRequest());

	return new Promise<ByteOutcome>((resolve, reject) => {
		const xhr = make();
		let settled = false;

		const fail = () => {
			if (settled) return;
			settled = true;
			reject(new UploadUnreachable());
		};

		xhr.open('POST', input.url, true);
		xhr.responseType = 'text';
		xhr.setRequestHeader('accept', 'application/json');
		xhr.setRequestHeader('content-type', input.contentType);

		if (input.onProgress) {
			const report = input.onProgress;
			// `upload` is where the interesting events are: `xhr.onprogress` is the
			// *download*, which for this route is a 200-byte JSON row.
			xhr.upload?.addEventListener('progress', (event: ProgressEvent) => {
				report(event.loaded, event.lengthComputable ? event.total : null);
			});
		}

		xhr.addEventListener('error', fail);
		xhr.addEventListener('timeout', fail);
		xhr.addEventListener('abort', fail);

		xhr.addEventListener('load', () => {
			if (settled) return;
			settled = true;
			// Status 0 with a `load` event is a CORS or network failure wearing a
			// success event; it has no answer in it.
			if (xhr.status === 0) {
				reject(new UploadUnreachable());
				return;
			}
			resolve({
				status: xhr.status,
				ok: xhr.status >= 200 && xhr.status < 300,
				body: parse(xhr.responseText)
			});
		});

		xhr.send(input.file);
	});
}

/** A body that is not JSON is not a crash: a proxy error page is still an answer. */
function parse(text: string | null | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
