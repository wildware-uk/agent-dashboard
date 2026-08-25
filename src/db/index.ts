/**
 * Public entry point for the persistence module.
 *
 * Other modules import from `$db`, never from a file inside it, so the
 * repository surface can be reorganised without touching callers.
 *
 * Filled in by the `src/db/` slice (design §11 step 2): connection, migration
 * runner, schema, repositories. See ./README.md for the boundary rules.
 */
export {};
