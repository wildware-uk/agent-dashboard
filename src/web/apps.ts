/**
 * Which apps are on which card, in the browser (migration 041).
 *
 * The snapshot carries one flat list of every showing on the page, for the
 * reason the card fields arrive as one list: the client keys it by card, and a
 * map nested per kind would be three shapes to merge rather than one to filter.
 */
import type { AppView } from './types';

/** The showings on one card, oldest first — the order they were posted in. */
export function appsOnCard(
	card: { kind: string; id: string },
	apps: readonly AppView[]
): AppView[] {
	return apps
		.filter((app) => app.card.kind === card.kind && app.card.id === card.id)
		.sort((left, right) => left.createdAt - right.createdAt);
}
