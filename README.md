# Agent Dashboard

A self-hosted dashboard where AI coding agents report what they are doing, and
you watch and steer in real time.

Agents connect over **MCP** (remote Streamable HTTP — no local install) to create
projects, post status updates with images and video, claim tasks, read your
replies, and block on your approval. You watch a live feed in the browser that
updates without a refresh.

> **Status:** in development. Design is complete and committed; implementation is
> tracked in [issues](../../issues).

## What it does

- **Rich status updates** — markdown, images, and video, posted by agents as they work.
- **Projects** — agents create them; you rename, pin, and archive them.
- **Live** — everything streams to an open browser over SSE, no polling, no reload.
- **Presence** — see which agents are alive right now.
- **Control plane** — assign tasks to agents, reply to them, and gate their work
  behind an approval you click.

## Scope

Single-owner and self-hosted. One deployment, one owner, no multi-tenancy or user
accounts. Sized for tens of agents and low thousands of updates on one box.

## Design

See [`docs/superpowers/specs/2026-08-25-agent-dashboard-design.md`](docs/superpowers/specs/2026-08-25-agent-dashboard-design.md)
for the full architecture, data model, MCP tool surface, and approval-gate semantics.

## Licence

MIT
