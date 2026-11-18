/**
 * Put back the two `media` indexes that migration 038 lost.
 *
 * Migration 030 created `media_request` and `media_task`, the reads a request
 * card and a task make for their attachments. 038 rebuilt `media` to let audio
 * in and recreated every index it knew of, but not these two, so a fully
 * migrated database has scanned the whole table for those reads ever since.
 *
 * Same names and columns as 030. The SQL is checksummed like every other
 * migration, so any other server that opens this database must ship it byte for
 * byte.
 */
export const sql = `
CREATE INDEX media_request ON media (request_id);
CREATE INDEX media_task ON media (task_id);
`;
