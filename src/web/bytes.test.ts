import { describe, expect, it, vi } from 'vitest';
import { putBytes, UploadUnreachable, type XhrFactory } from './bytes';

/**
 * Watching one file go (the owner: "I'd also like to see upload progress on files").
 *
 * `fetch` cannot report upload progress, so this path is `XMLHttpRequest`. The
 * fake below is the smallest thing that satisfies the three events this module
 * listens to, which is also the honest statement of what it depends on.
 */
type Listener = (event: ProgressEvent) => void;

class FakeXhr {
	status = 0;
	responseText = '';
	responseType = '';
	readonly headers: Record<string, string> = {};
	readonly opened: { method: string; url: string }[] = [];
	sent: unknown;

	private readonly own = new Map<string, Listener[]>();
	private readonly uploadOwn = new Map<string, Listener[]>();

	readonly upload = {
		addEventListener: (name: string, listener: Listener) => {
			this.uploadOwn.set(name, [...(this.uploadOwn.get(name) ?? []), listener]);
		}
	};

	open(method: string, url: string) {
		this.opened.push({ method, url });
	}
	setRequestHeader(name: string, value: string) {
		this.headers[name] = value;
	}
	addEventListener(name: string, listener: Listener) {
		this.own.set(name, [...(this.own.get(name) ?? []), listener]);
	}
	send(body: unknown) {
		this.sent = body;
	}

	/** Pretend some bytes left. */
	progress(loaded: number, total?: number) {
		const event = {
			loaded,
			total: total ?? 0,
			lengthComputable: total !== undefined
		} as ProgressEvent;
		for (const listener of this.uploadOwn.get('progress') ?? []) listener(event);
	}

	/** Pretend the server answered. */
	finish(status: number, text = '') {
		this.status = status;
		this.responseText = text;
		for (const listener of this.own.get('load') ?? []) listener({} as ProgressEvent);
	}

	/** Pretend it never landed. */
	die(name: 'error' | 'timeout' | 'abort' = 'error') {
		for (const listener of this.own.get(name) ?? []) listener({} as ProgressEvent);
	}
}

function fake(): { xhr: FakeXhr; make: XhrFactory } {
	const xhr = new FakeXhr();
	return { xhr, make: () => xhr as unknown as XMLHttpRequest };
}

const file = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

describe('putBytes', () => {
	it('reports progress as the bytes leave, then answers with the row', async () => {
		const { xhr, make } = fake();
		const seen: [number, number | null][] = [];

		const done = putBytes({
			url: '/api/media?filename=shot.png',
			file: file(),
			contentType: 'image/png',
			onProgress: (sent, total) => seen.push([sent, total]),
			make
		});

		xhr.progress(40, 100);
		xhr.progress(100, 100);
		xhr.finish(201, JSON.stringify({ media: { id: 'm1' } }));

		await expect(done).resolves.toEqual({
			status: 201,
			ok: true,
			body: { media: { id: 'm1' } }
		});
		expect(seen).toEqual([
			[40, 100],
			[100, 100]
		]);
		expect(xhr.opened).toEqual([{ method: 'POST', url: '/api/media?filename=shot.png' }]);
		expect(xhr.headers).toEqual({ accept: 'application/json', 'content-type': 'image/png' });
	});

	it('says nothing about the total when the browser cannot', async () => {
		const { xhr, make } = fake();
		const seen: (number | null)[] = [];

		const done = putBytes({
			url: '/api/media',
			file: file(),
			contentType: 'image/png',
			onProgress: (_sent, total) => seen.push(total),
			make
		});

		xhr.progress(40);
		xhr.finish(201, '{}');
		await done;

		// null, not 0: a caller dividing by this must notice, rather than show a
		// bar pinned at infinity.
		expect(seen).toEqual([null]);
	});

	it('resolves a refusal rather than throwing it: a 413 is an answer', async () => {
		const { xhr, make } = fake();

		const done = putBytes({ url: '/api/media', file: file(), contentType: 'image/png', make });
		xhr.finish(413, JSON.stringify({ error: 'too_large', message: 'too big' }));

		await expect(done).resolves.toMatchObject({
			status: 413,
			ok: false,
			body: { error: 'too_large' }
		});
	});

	it('treats a body that is not JSON as no body: a proxy error page is still an answer', async () => {
		const { xhr, make } = fake();

		const done = putBytes({ url: '/api/media', file: file(), contentType: 'image/png', make });
		xhr.finish(502, '<html>Bad Gateway</html>');

		await expect(done).resolves.toEqual({ status: 502, ok: false, body: null });
	});

	it.each(['error', 'timeout', 'abort'] as const)('rejects when the request %ss', async (how) => {
		const { xhr, make } = fake();

		const done = putBytes({ url: '/api/media', file: file(), contentType: 'image/png', make });
		xhr.die(how);

		await expect(done).rejects.toBeInstanceOf(UploadUnreachable);
	});

	it('rejects a load with status 0: a network failure wearing a success event', async () => {
		const { xhr, make } = fake();

		const done = putBytes({ url: '/api/media', file: file(), contentType: 'image/png', make });
		xhr.finish(0, '');

		await expect(done).rejects.toBeInstanceOf(UploadUnreachable);
	});

	it('sends the file as the whole body, with no wrapper', async () => {
		const { xhr, make } = fake();
		const blob = file();

		const done = putBytes({ url: '/api/media', file: blob, contentType: 'image/png', make });
		xhr.finish(201, '{}');
		await done;

		expect(xhr.sent).toBe(blob);
	});

	it('does not listen for progress when nobody asked', async () => {
		const { xhr, make } = fake();
		const spy = vi.spyOn(xhr.upload, 'addEventListener');

		const done = putBytes({ url: '/api/media', file: file(), contentType: 'image/png', make });
		xhr.finish(201, '{}');
		await done;

		expect(spy).not.toHaveBeenCalled();
	});
});
