/**
 * Parsing the one form of `Range` this app answers.
 *
 * Video seeking is not optional politeness: a browser asked to jump to 8s in a
 * 2MB mp4 issues a byte range, and a server that answers `200` with the whole
 * file makes the player give up and snap back to the start. That is what
 * `accept-ranges: none` cost here — the scrub bar and frame stepping both looked
 * broken while the bug was in the response headers.
 *
 * Only a single range is understood. Multipart ranges are legal but no media
 * player asks for them, and answering `200` with the full body is an allowed
 * response to a range request, so an unrecognised header degrades rather than
 * fails.
 */

/** An inclusive byte span, as HTTP counts them. */
export type ByteRange = { start: number; end: number };

export type RangeVerdict =
	/** No range header, or one we deliberately do not honour: send the whole file. */
	| { kind: 'whole' }
	/** A satisfiable single range: send 206 for exactly this span. */
	| { kind: 'partial'; range: ByteRange }
	/** Syntactically fine but outside the file: 416, per RFC 9110. */
	| { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Work out what to answer for a `Range` header against a file of `size` bytes.
 *
 * @param header the raw `Range` header, or null.
 * @param size the full length of the representation.
 */
export function resolveRange(header: string | null, size: number): RangeVerdict {
	if (!header) return { kind: 'whole' };

	const match = SINGLE_RANGE.exec(header.trim());
	// Multipart or malformed: RFC 9110 lets us ignore the header entirely.
	if (!match) return { kind: 'whole' };

	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return { kind: 'whole' };

	// A zero-length file can satisfy no range at all.
	if (size === 0) return { kind: 'unsatisfiable' };

	if (rawStart === '') {
		// `bytes=-500` means the LAST 500 bytes, not "up to 500".
		const wanted = Number(rawEnd);
		if (wanted === 0) return { kind: 'unsatisfiable' };
		const start = Math.max(size - wanted, 0);
		return { kind: 'partial', range: { start, end: size - 1 } };
	}

	const start = Number(rawStart);
	if (start >= size) return { kind: 'unsatisfiable' };

	// An absent or over-long end is clamped to the last byte, which is what makes
	// the usual `bytes=0-` from a media element work.
	const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (end < start) return { kind: 'unsatisfiable' };

	return { kind: 'partial', range: { start, end } };
}
