/**
 * Putting each source's own mark on its embeds.
 *
 * The owner, looking at the five looks migration 028 shaped: "I would expect
 * embeds to at least have the slack/github icon etc."
 *
 * They were right, and the reason is worth writing down because it cuts against
 * what 028 was for. A real Slack message carries no Slack logo — you are already
 * in Slack — so making the built-ins faithful meant taking the badges off, and
 * that left four white cards that were shaped differently and marked not at all.
 * But a dashboard is not Slack. It is a wall of quotations from four places at
 * once, and the first thing anybody needs from one is where it came from.
 *
 * So the mark comes back, in the form that costs the fidelity nothing: a small
 * glyph in the card's top corner, held slightly back, drawn over the card rather
 * than in its flow. The Slack card is still a Slack message; it now says so.
 *
 * Each mark is inline SVG the client owns (`src/web/EmbedMark.svelte`), named
 * from a closed list. Nothing is fetched, so a mark cannot leak the owner's
 * address to a third party or disappear when somebody's CDN does, and a look
 * carries a name rather than anything that could become markup. A source we ship
 * no mark for uses `chrome.image`, which is an ordinary uploaded picture.
 *
 * `linked-page` keeps a label as well: a generic link card has no brand of its
 * own, so the site's name is the only thing that says where it is from.
 *
 * As with 028 this is an UPDATE scoped to `agent_id IS NULL`, so it restyles the
 * embeds already posted in the built-in looks and leaves every look an agent
 * registered alone.
 */

export const sql = `
UPDATE embed_types SET spec = '{"theme":{"accent":"#611f69","background":"#ffffff","foreground":"#1d1c1d","muted":"#616061","border":"#e2e2e2","font":"sans","radius":"sm"},"frame":{"border":true,"stripe":false,"padding":"roomy","indent":true},"blocks":[{"type":"header","avatar":"{{avatar}}","title":"{{username}}","meta":"{{time}}","shape":"rounded","size":"md","layout":"inline"},{"type":"markdown","value":"{{text}}","size":"md"},{"type":"chips","value":"{{reactions}}","style":"pill"},{"type":"footer","value":"{{channel}}","url":"{{permalink}}"}],"chrome":{"mark":"slack"}}'
 WHERE slug = 'slack-message' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#0969da","background":"#ffffff","foreground":"#1f2328","muted":"#59636e","border":"#d1d9e0","font":"sans","radius":"md"},"frame":{"border":true,"stripe":false,"padding":"normal"},"blocks":[{"type":"header","avatar":"{{avatar}}","title":"{{username}}","subtitle":"commented","meta":"{{time}}","shape":"circle","size":"sm","layout":"inline","bar":true},{"type":"markdown","value":"{{body}}","size":"md"},{"type":"chips","value":"{{labels}}","style":"tag"},{"type":"footer","value":"{{repo}} {{issue}}","url":"{{url}}"}],"chrome":{"mark":"github"}}'
 WHERE slug = 'github-comment' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#0052cc","background":"#ffffff","foreground":"#172b4d","muted":"#626f86","border":"#dfe1e6","font":"sans","radius":"sm"},"frame":{"border":true,"stripe":false,"padding":"normal"},"blocks":[{"type":"text","value":"{{key}}","tone":"accent","size":"sm"},{"type":"heading","value":"{{summary}}","level":2},{"type":"chips","value":"{{status}}","style":"lozenge"},{"type":"fields","layout":"rows","items":[{"label":"Project","value":"{{project}}"},{"label":"Assignee","value":"{{assignee}}"},{"label":"Reporter","value":"{{reporter}}"},{"label":"Priority","value":"{{priority}}"}]},{"type":"markdown","value":"{{description}}","size":"sm"},{"type":"chips","value":"{{labels}}","style":"tag"},{"type":"footer","value":"Open in Jira","url":"{{url}}"}],"chrome":{"mark":"jira"}}'
 WHERE slug = 'jira-issue' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#1868db","background":"#ffffff","foreground":"#172b4d","muted":"#626f86","border":"#dfe1e6","font":"sans","radius":"sm"},"frame":{"border":true,"stripe":false,"padding":"roomy"},"blocks":[{"type":"text","value":"{{space}}","tone":"muted","size":"sm"},{"type":"heading","value":"{{title}}","level":1},{"type":"header","avatar":"{{avatar}}","title":"{{author}}","meta":"{{updated}}","shape":"circle","size":"sm","layout":"inline"},{"type":"divider"},{"type":"markdown","value":"{{body}}","size":"md"},{"type":"footer","value":"Open in Confluence","url":"{{url}}"}],"chrome":{"mark":"confluence"}}'
 WHERE slug = 'confluence-page' AND agent_id IS NULL;

UPDATE embed_types SET spec = '{"theme":{"accent":"#5b6672","background":"#ffffff","foreground":"#1f2328","muted":"#59636e","border":"#d7dbe0","font":"sans","radius":"md"},"frame":{"border":true,"stripe":false,"padding":"normal"},"blocks":[{"type":"header","avatar":"{{image}}","title":"{{title}}","subtitle":"{{site}}","shape":"square","size":"lg","layout":"stacked"},{"type":"text","value":"{{description}}","tone":"muted","size":"sm"},{"type":"footer","value":"{{url}}","url":"{{url}}"}],"chrome":{"mark":"link","label":"{{site}}"}}'
 WHERE slug = 'linked-page' AND agent_id IS NULL;
`;
