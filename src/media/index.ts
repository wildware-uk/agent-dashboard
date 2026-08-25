/**
 * Public entry point for the media pipeline.
 *
 * The whole surface is `ingest()` and `derivativesFor()`; callers never learn
 * disk paths. Import from `$media`, never from a file inside it.
 *
 * Filled in by the media slices (design §11 steps 9-10). See ./README.md.
 */
export {};
