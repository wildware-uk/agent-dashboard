import {
	findMediaById,
	insertMedia,
	listMediaForUpdate,
	setMediaStatus,
	upsertDerivative
} from '$db';
import { ORPHAN_AGE_MS } from '$media';
import { bodyOf, pngBytes, tempSettings } from '$media/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDomainError, type DomainErrorCode } from './errors';
import {
	MEDIA_PER_UPDATE_MAX,
	MEDIA_SWEEP_INTERVAL_MS,
	attachMedia,
	createUpload,
	ingestUpload,
	listUpdateMedia,
	readMediaVariant,
	startMediaSweeper,
	sweepMedia
} from './media';
import { createProject } from './projects';
import { FIXED_NOW, harness, type Harness } from './testing';
import { deleteUpdate, postUpdate } from './updates';

let ctx: Harness;
let agentId: string;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];

beforeEach(() => {
	ctx = harness();
	agentId = ctx.agent('claude');
	temp = tempSettings();
	settings = temp.settings;
	createProject(ctx, { name: 'Agent Dashboard' });
	ctx.events.length = 0;
});

afterEach(() => temp.cleanup());

/** The domain code a refusal carried. */
function refusal(body: () => unknown): DomainErrorCode | undefined {
	try {
		body();
		return undefined;
	} catch (error) {
		if (!isDomainError(error)) throw error;
		return error.code;
	}
}

const grant = () =>
	createUpload(
		ctx,
		{ agentId, filename: 'shot.png', mime: 'image/png', bytes: pngBytes().length },
		settings
	);

/** A media row that already has bytes, without going through the wire. */
const landed = (over: Partial<Parameters<typeof insertMedia>[1]> = {}) =>
	insertMedia(ctx.db, {
		agentId,
		kind: 'image',
		mime: 'image/png',
		bytes: 10,
		sha256: `sha-${Math.random()}`,
		status: 'ready',
		...over
	}).id;

describe('createUpload', () => {
	it('hands an agent everything it needs to PUT, and nothing else', () => {
		const created = grant();

		expect(created.uploadUrl.startsWith(`${settings.baseUrl}/api/upload/`)).toBe(true);
		expect(created.expiresAt).toBe(FIXED_NOW + 15 * 60 * 1000);
		expect(created.maxBytes).toBe(pngBytes().length);
		expect(findMediaById(ctx.db, created.mediaId)!.agentId).toBe(agentId);
	});

	it('says nothing on the bus: an empty reservation is not news', () => {
		grant();

		expect(ctx.eventNames()).toEqual([]);
	});

	it('reports a type off the allowlist as an argument the agent can fix', () => {
		expect(refusal(() => createUpload(ctx, { ...args(), mime: 'image/svg+xml' }, settings))).toBe(
			'invalid_argument'
		);
		expect(refusal(() => createUpload(ctx, { ...args(), bytes: 0 }, settings))).toBe(
			'invalid_argument'
		);
	});

	it('reports an unknown agent as not found', () => {
		expect(refusal(() => createUpload(ctx, { ...args(), agentId: 'nobody' }, settings))).toBe(
			'not_found'
		);
	});

	function args() {
		return { agentId, filename: 'shot.png', mime: 'image/png', bytes: 1024 };
	}
});

describe('ingestUpload', () => {
	it('lands the bytes and answers with what was stored', async () => {
		const created = grant();
		const bytes = pngBytes();

		const result = await ingestUpload(
			ctx,
			{ token: created.token, body: bodyOf(bytes), contentLength: bytes.length },
			settings
		);

		expect(result.mediaId).toBe(created.mediaId);
		expect(result.bytes).toBe(bytes.length);
		expect(result.mime).toBe('image/png');
		expect(result.kind).toBe('image');
		expect(result.deduped).toBe(false);
		// Still pending: the derivative pipeline is what flips it and publishes.
		expect(result.status).toBe('pending');
		expect(ctx.eventNames()).toEqual([]);
	});

	it('serves the same bytes straight back out', async () => {
		const created = grant();
		await ingestUpload(ctx, { token: created.token, body: bodyOf(pngBytes()) }, settings);

		const file = await readMediaVariant(
			ctx,
			{ id: created.mediaId, variant: 'original' },
			settings
		);

		expect(file.mime).toBe('image/png');
		expect(file.bytes).toBe(pngBytes().length);
	});
});

describe('attachMedia and the update it names', () => {
	it("refuses another agent's update, which its own description promises", () => {
		// The tool says "an update YOU have already posted". Media ownership was
		// filtered but the update's was not, so one agent could hang an image on
		// another agent's card — a documented precondition the server did not check.
		const otherAgent = ctx.agent('someone-else');
		const theirUpdate = postUpdate(ctx, {
			project: 'agent-dashboard',
			agentId: otherAgent,
			body: 'their work'
		});
		const mine = landed();

		expect(
			refusal(() => attachMedia(ctx, { updateId: theirUpdate.id, mediaIds: [mine], agentId }))
		).toBe('not_found');
	});
});

describe('attachMedia', () => {
	it('points the agent`s own unattached media at its update', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shipped' });
		const first = landed();
		const second = landed();

		const result = attachMedia(ctx, { updateId: update.id, mediaIds: [first, second], agentId });

		expect(result.attached).toEqual([first, second]);
		expect(result.skipped).toEqual([]);
		expect(listMediaForUpdate(ctx.db, update.id).map((media) => media.id)).toEqual([first, second]);
	});

	it('skips media belonging to another agent, and says which', () => {
		const other = ctx.agent('codex');
		const mine = landed();
		const theirs = landed({ agentId: other });
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shipped' });

		const result = attachMedia(ctx, { updateId: update.id, mediaIds: [mine, theirs], agentId });

		expect(result.attached).toEqual([mine]);
		expect(result.skipped).toEqual([theirs]);
		expect(findMediaById(ctx.db, theirs)!.updateId).toBeNull();
	});

	it('skips media that some other update already claimed', () => {
		const media = landed();
		const first = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'one' });
		const second = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'two' });

		attachMedia(ctx, { updateId: first.id, mediaIds: [media], agentId });
		const result = attachMedia(ctx, { updateId: second.id, mediaIds: [media], agentId });

		expect(result.attached).toEqual([]);
		expect(result.skipped).toEqual([media]);
		expect(findMediaById(ctx.db, media)!.updateId).toBe(first.id);
	});

	it('refuses an update that does not exist, or has been deleted', () => {
		const media = landed();
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'gone' });
		deleteUpdate(ctx, update.id);

		expect(refusal(() => attachMedia(ctx, { updateId: 'nope', mediaIds: [media], agentId }))).toBe(
			'not_found'
		);
		expect(
			refusal(() => attachMedia(ctx, { updateId: update.id, mediaIds: [media], agentId }))
		).toBe('not_found');
	});

	it('refuses a list that is empty, malformed, or absurdly long', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shipped' });

		expect(refusal(() => attachMedia(ctx, { updateId: update.id, mediaIds: [], agentId }))).toBe(
			'invalid_argument'
		);
		expect(
			refusal(() => attachMedia(ctx, { updateId: update.id, mediaIds: ['../secret'], agentId }))
		).toBe('invalid_argument');
		expect(
			refusal(() =>
				attachMedia(ctx, {
					updateId: update.id,
					mediaIds: Array.from({ length: MEDIA_PER_UPDATE_MAX + 1 }, () => landed()),
					agentId
				})
			)
		).toBe('invalid_argument');
	});

	it('skips a reservation whose bytes never arrived, rather than posting a broken tile', () => {
		const reserved = createUpload(
			ctx,
			{ agentId, filename: 'shot.png', mime: 'image/png', bytes: 100 },
			settings
		);
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shipped' });

		const result = attachMedia(ctx, {
			updateId: update.id,
			mediaIds: [reserved.mediaId],
			agentId
		});

		expect(result.attached).toEqual([]);
		expect(result.skipped).toEqual([reserved.mediaId]);
	});

	it('takes each id once, however many times it is listed', () => {
		const media = landed();
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shipped' });

		const result = attachMedia(ctx, {
			updateId: update.id,
			mediaIds: [media, media, media],
			agentId
		});

		expect(result.attached).toEqual([media]);
	});
});

describe('post_update taking media_ids', () => {
	it('attaches them as part of posting, so the card arrives complete', () => {
		const media = landed();

		const update = postUpdate(ctx, {
			project: 'agent-dashboard',
			agentId,
			body: 'shipped',
			mediaIds: [media]
		});

		expect(listMediaForUpdate(ctx.db, update.id).map((row) => row.id)).toEqual([media]);
		// One event, and it is published after the media is attached, so a browser
		// that fetches the update on hearing about it sees the whole card.
		expect(ctx.eventNames()).toEqual(['update.created']);
	});

	it('refuses the whole post if any id is not the agent`s to attach', () => {
		const other = ctx.agent('codex');
		const theirs = landed({ agentId: other });

		expect(
			refusal(() =>
				postUpdate(ctx, {
					project: 'agent-dashboard',
					agentId,
					body: 'shipped',
					mediaIds: [theirs]
				})
			)
		).toBe('invalid_argument');
		// Nothing half-posted: no update row, and their media is untouched.
		expect(ctx.eventNames()).toEqual([]);
		expect(findMediaById(ctx.db, theirs)!.updateId).toBeNull();
	});

	it('refuses an id whose bytes have not arrived yet, and says to upload them first', () => {
		const reserved = createUpload(
			ctx,
			{ agentId, filename: 'shot.png', mime: 'image/png', bytes: 100 },
			settings
		);

		expect(
			refusal(() =>
				postUpdate(ctx, {
					project: 'agent-dashboard',
					agentId,
					body: 'shipped',
					mediaIds: [reserved.mediaId]
				})
			)
		).toBe('invalid_argument');
	});

	it('refuses an id nothing was ever uploaded for', () => {
		expect(
			refusal(() =>
				postUpdate(ctx, {
					project: 'agent-dashboard',
					agentId,
					body: 'shipped',
					mediaIds: ['01K3ABCDEFGHJKMNPQRSTVWXYZ']
				})
			)
		).toBe('not_found');
	});
});

describe('startMediaSweeper', () => {
	it('sweeps on a timer, and survives a tick that throws', async () => {
		vi.useFakeTimers();
		const errors: unknown[] = [];
		const orphan = landed();
		setMediaStatus(ctx.db, orphan, { status: 'ready' });
		ctx.db
			.prepare('UPDATE media SET created_at = ? WHERE id = ?')
			.run(FIXED_NOW - ORPHAN_AGE_MS - 1, orphan);

		// No settings argument, so the tick reads the environment — which in a test
		// does not validate. That must be logged, not thrown out of a timer.
		const stop = startMediaSweeper({
			context: () => ctx,
			intervalMs: 1000,
			onError: (error) => errors.push(error)
		});

		try {
			await vi.advanceTimersByTimeAsync(1000);

			expect(errors).toHaveLength(1);
			expect(findMediaById(ctx.db, orphan)).toBeTruthy();
		} finally {
			stop();
			vi.useRealTimers();
		}
	});

	it('sweeps with this deployment`s settings on every tick', async () => {
		vi.useFakeTimers();
		let ticks = 0;
		const errors: unknown[] = [];

		const stop = startMediaSweeper({
			context: () => ctx,
			intervalMs: 1000,
			settings: () => {
				ticks += 1;
				return settings;
			},
			onError: (error) => errors.push(error)
		});

		try {
			await vi.advanceTimersByTimeAsync(2000);

			expect(ticks).toBe(2);
			expect(errors).toEqual([]);
		} finally {
			stop();
			vi.useRealTimers();
		}
	});

	it('stops when it is told to', async () => {
		vi.useFakeTimers();
		let ticks = 0;

		const stop = startMediaSweeper({
			context: () => ctx,
			intervalMs: 1000,
			settings: () => {
				ticks += 1;
				return settings;
			}
		});
		stop();

		try {
			await vi.advanceTimersByTimeAsync(5000);

			expect(ticks).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('runs every quarter hour, well inside the hour an orphan is given', () => {
		expect(MEDIA_SWEEP_INTERVAL_MS).toBeLessThan(ORPHAN_AGE_MS);
	});
});

describe('sweepMedia', () => {
	it('collects the orphans the media module finds', async () => {
		const orphan = landed();
		setMediaStatus(ctx.db, orphan, { status: 'ready' });
		ctx.db
			.prepare('UPDATE media SET created_at = ? WHERE id = ?')
			.run(FIXED_NOW - ORPHAN_AGE_MS - 1, orphan);

		const swept = await sweepMedia(ctx, {}, settings);

		expect(swept.media).toBe(1);
		expect(findMediaById(ctx.db, orphan)).toBeUndefined();
	});
});

/**
 * What the browser is told about the media on a card (design §6 step 5, §7).
 *
 * The rule these tests pin down: the wire carries the *stored* dimensions and
 * the variants that actually exist, because both are what lets a grid reserve
 * the right box before a byte of image has loaded, and what stops it offering an
 * address that would answer 404.
 */
describe('listUpdateMedia', () => {
	/** A ready image with the two thumbnails the pipeline produces (design §6). */
	function readyImage(over: Partial<Parameters<typeof insertMedia>[1]> = {}): string {
		const id = landed({ width: 1200, height: 800, ...over });
		for (const width of [640, 1600]) {
			upsertDerivative(ctx.db, {
				mediaId: id,
				kind: 'thumb',
				path: `xx/${id}/thumb-${width}.webp`,
				bytes: 100,
				width,
				height: Math.round((width * 800) / 1200)
			});
		}
		return id;
	}

	it('groups an update`s media in the order it was uploaded', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shots' });
		const first = readyImage();
		const second = readyImage();
		attachMedia(ctx, { agentId, updateId: update.id, mediaIds: [first, second] });

		const byUpdate = listUpdateMedia(ctx, [update.id]);

		expect(byUpdate[update.id].map((item) => item.id)).toEqual([first, second]);
		expect(listMediaForUpdate(ctx.db, update.id).map((row) => row.id)).toEqual([first, second]);
	});

	it('carries the stored dimensions, so a grid can size the box before it loads', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shot' });
		attachMedia(ctx, { agentId, updateId: update.id, mediaIds: [readyImage()] });

		const [item] = listUpdateMedia(ctx, [update.id])[update.id];

		expect(item).toMatchObject({ kind: 'image', status: 'ready', width: 1200, height: 800 });
	});

	it('names the variants a ready image really has', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shot' });
		attachMedia(ctx, { agentId, updateId: update.id, mediaIds: [readyImage()] });

		const [item] = listUpdateMedia(ctx, [update.id])[update.id];

		expect([...item.variants].sort()).toEqual(['original', 'thumb-640', 'thumb-1600'].sort());
	});

	it('offers a poster and the transcode for a video, and the original for one that needs none', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'clip' });
		const transcoded = landed({ kind: 'video', mime: 'video/quicktime', durationMs: 7000 });
		const playable = landed({ kind: 'video', mime: 'video/mp4', durationMs: 3000 });
		for (const id of [transcoded, playable]) {
			upsertDerivative(ctx.db, {
				mediaId: id,
				kind: 'poster',
				path: `xx/${id}/poster.jpg`,
				bytes: 9
			});
		}
		upsertDerivative(ctx.db, {
			mediaId: transcoded,
			kind: 'mp4',
			path: `xx/${transcoded}/video.mp4`,
			bytes: 99
		});
		attachMedia(ctx, { agentId, updateId: update.id, mediaIds: [transcoded, playable] });

		const items = listUpdateMedia(ctx, [update.id])[update.id];

		expect(items[0].variants).toContain('video');
		expect(items[0].variants).toContain('poster');
		expect(items[0].durationMs).toBe(7000);
		// A web-playable mp4 gets no transcode (`src/media/derive.ts`), so the only
		// thing the browser can play is the original — and it has to be told that.
		expect(items[1].variants).not.toContain('video');
		expect(items[1].variants).toEqual(expect.arrayContaining(['original', 'poster']));
	});

	it('says a pending item is pending and offers it no derivative to render', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shot' });
		const pending = landed({ status: 'pending' });
		attachMedia(ctx, { agentId, updateId: update.id, mediaIds: [pending] });

		const [item] = listUpdateMedia(ctx, [update.id])[update.id];

		expect(item.status).toBe('pending');
		expect(item.variants).not.toContain('thumb-640');
	});

	it('says a failed item is failed and offers nothing at all to render', () => {
		const update = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shot' });
		const broken = readyImage();
		attachMedia(ctx, { agentId, updateId: update.id, mediaIds: [broken] });
		setMediaStatus(ctx.db, broken, { status: 'failed' });

		const [item] = listUpdateMedia(ctx, [update.id])[update.id];

		expect(item.status).toBe('failed');
		// Every address 404s for a failed row (`src/media/serve.ts`), so a UI that
		// was handed one would render a broken image icon.
		expect(item.variants).toEqual([]);
	});

	it('reads many updates at once and leaves out the ones with nothing attached', () => {
		const withMedia = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'shot' });
		const without = postUpdate(ctx, { project: 'agent-dashboard', agentId, body: 'words' });
		attachMedia(ctx, { agentId, updateId: withMedia.id, mediaIds: [readyImage()] });

		const byUpdate = listUpdateMedia(ctx, [withMedia.id, without.id, 'no-such-update']);

		expect(Object.keys(byUpdate)).toEqual([withMedia.id]);
	});

	it('reads nothing for no updates', () => {
		expect(listUpdateMedia(ctx, [])).toEqual({});
	});
});
