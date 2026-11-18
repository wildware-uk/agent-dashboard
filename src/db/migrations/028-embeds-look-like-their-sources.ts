/**
 * Making the built-in looks actually look like their sources.
 *
 * The owner, on seeing migration 027 land: "Can you make the embeds look
 * identical to their sources, I want the slack to look like a slack message."
 *
 * They were right, and the reason was structural rather than cosmetic. Migration
 * 027 gave a look a palette and an ordered list of blocks, and drew every one of
 * them the same way: a tinted badge bar along the top, an accent stripe down the
 * left, an avatar in a fixed size, one chip shape. A Slack message has none of
 * those things. It is a rounded-square avatar with the name and the time on one
 * line, the text at fifteen pixels underneath, outlined reaction pills below
 * that, and no badge anywhere — because in Slack you already know you are in
 * Slack.
 *
 * ## What changed, and where
 *
 * The vocabulary grew (`src/domain/embeds.ts`): a look can now say the avatar's
 * shape and size, whether its header is one line or two, whether the header is a
 * tinted bar, which of three chip shapes to use, how a field table is laid out,
 * and whether the card has a border, a stripe and how much air. Every one is a
 * closed list, exactly as the colours are hex literals — the renderer turns each
 * into a class it wrote itself, so nothing an agent sends reaches CSS.
 *
 * This migration is the other half: the five looks the deployment ships,
 * rewritten to use it.
 *
 * - **Slack** — no badge, no stripe, roomy. Rounded-square 36px avatar; name and
 *   time on one line; 15px body; outlined reaction pills; the channel as the
 *   footer, linking to the permalink.
 * - **GitHub** — the header is a tinted bar with a small circular avatar and
 *   "commented", above a white body, which is a comment box exactly.
 * - **Jira** — the key in blue above the summary as a heading, the status as an
 *   uppercase lozenge, then the field table, then the description.
 * - **Confluence** — the space, then the title at page size, then who last
 *   touched it, a rule, and the body.
 * - **Linked page** — an OpenGraph card: square thumbnail, title, site,
 *   description, URL.
 *
 * ## Why this is an UPDATE and not five new rows
 *
 * It restyles every embed already posted, which is the property the two-table
 * split was for (migration 027): a look is not an instance, so correcting the
 * look corrects everything drawn in it. The ids and slugs do not move, so
 * nothing an agent has written down stops working.
 *
 * `agent_id IS NULL` scopes it to the ones this deployment ships. An agent that
 * registered a look of its own is not touched — this is a correction to our
 * defaults, not to anybody's work.
 */

export const sql = `
UPDATE embed_types SET spec = '{"theme":{"accent":"#611f69","background":"#ffffff","foreground":"#1d1c1d","muted":"#616061","border":"#e2e2e2","font":"sans","radius":"sm"},"frame":{"border":true,"stripe":false,"padding":"roomy","indent":true},"blocks":[{"type":"header","avatar":"{{avatar}}","title":"{{username}}","meta":"{{time}}","shape":"rounded","size":"md","layout":"inline"},{"type":"markdown","value":"{{text}}","size":"md"},{"type":"chips","value":"{{reactions}}","style":"pill"},{"type":"footer","value":"{{channel}}","url":"{{permalink}}"}]}'
 WHERE slug = 'slack-message' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#0969da","background":"#ffffff","foreground":"#1f2328","muted":"#59636e","border":"#d1d9e0","font":"sans","radius":"md"},"frame":{"border":true,"stripe":false,"padding":"normal"},"blocks":[{"type":"header","avatar":"{{avatar}}","title":"{{username}}","subtitle":"commented","meta":"{{time}}","shape":"circle","size":"sm","layout":"inline","bar":true},{"type":"markdown","value":"{{body}}","size":"md"},{"type":"chips","value":"{{labels}}","style":"tag"},{"type":"footer","value":"{{repo}} {{issue}}","url":"{{url}}"}]}'
 WHERE slug = 'github-comment' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#0052cc","background":"#ffffff","foreground":"#172b4d","muted":"#626f86","border":"#dfe1e6","font":"sans","radius":"sm"},"frame":{"border":true,"stripe":false,"padding":"normal"},"blocks":[{"type":"text","value":"{{key}}","tone":"accent","size":"sm"},{"type":"heading","value":"{{summary}}","level":2},{"type":"chips","value":"{{status}}","style":"lozenge"},{"type":"fields","layout":"rows","items":[{"label":"Project","value":"{{project}}"},{"label":"Assignee","value":"{{assignee}}"},{"label":"Reporter","value":"{{reporter}}"},{"label":"Priority","value":"{{priority}}"}]},{"type":"markdown","value":"{{description}}","size":"sm"},{"type":"chips","value":"{{labels}}","style":"tag"},{"type":"footer","value":"Open in Jira","url":"{{url}}"}]}'
 WHERE slug = 'jira-issue' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#1868db","background":"#ffffff","foreground":"#172b4d","muted":"#626f86","border":"#dfe1e6","font":"sans","radius":"sm"},"frame":{"border":true,"stripe":false,"padding":"roomy"},"blocks":[{"type":"text","value":"{{space}}","tone":"muted","size":"sm"},{"type":"heading","value":"{{title}}","level":1},{"type":"header","avatar":"{{avatar}}","title":"{{author}}","meta":"{{updated}}","shape":"circle","size":"sm","layout":"inline"},{"type":"divider"},{"type":"markdown","value":"{{body}}","size":"md"},{"type":"footer","value":"Open in Confluence","url":"{{url}}"}]}'
 WHERE slug = 'confluence-page' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#5b6672","background":"#ffffff","foreground":"#1f2328","muted":"#59636e","border":"#d7dbe0","font":"sans","radius":"md"},"frame":{"border":true,"stripe":false,"padding":"normal"},"blocks":[{"type":"header","avatar":"{{image}}","title":"{{title}}","subtitle":"{{site}}","shape":"square","size":"lg","layout":"stacked"},{"type":"text","value":"{{description}}","tone":"muted","size":"sm"},{"type":"footer","value":"{{url}}","url":"{{url}}"}]}'
 WHERE slug = 'linked-page' AND agent_id IS NULL;
`;
