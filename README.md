# Taiga MCP Server

MCP server that exposes the [Taiga](https://www.taiga.io/) project management API as tools for LLM agents: projects, user stories, tasks, issues, epics, milestones (sprints), memberships, comments and search.

## Permission model

This server authenticates as **one Taiga user** (`TAIGA_USERNAME`/`TAIGA_PASSWORD`) and forwards every tool call to the Taiga API as that user. It does **not** re-implement a permission system on top of Taiga's own: whatever that user's role allows in each project is exactly what this server can do there, and Taiga rejects (HTTP 403) anything out of scope with a clear error surfaced back to the agent.

To delimit what this MCP server can do:

- Create a dedicated Taiga "bot" user for this integration (instead of using your personal account).
- In each project's **Settings → Attributes → Roles** (or member list), give that bot user a role with only the permissions you want to expose (e.g. a "read-only" role with `view_*` permissions but no `add_*`/`modify_*`/`delete_*`).
- Only invite that bot user to the specific projects it should be able to touch — projects it's not a member of are invisible to it (`taiga_list_projects` won't return them, and direct ID/slug access returns `Error: Resource not found`).

Because permissions are enforced by Taiga itself per request, this also means permissions can be changed at any time (e.g. revoke `delete_*` from the bot's role) without redeploying this server.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # then fill in TAIGA_USERNAME / TAIGA_PASSWORD
```

Environment variables:

| Variable | Required | Description |
|---|---|---|
| `TAIGA_USERNAME` | yes | Username or email of the Taiga account this server acts as |
| `TAIGA_PASSWORD` | yes | Password for that account |
| `TAIGA_API_URL` | no | Base API URL, defaults to `https://api.taiga.io/api/v1`. Point this at your self-hosted instance's `/api/v1` path if applicable |

### Run with an MCP client (e.g. Claude Code / Claude Desktop)

Add to your client's MCP server config:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-taiga/dist/index.js"],
      "env": {
        "TAIGA_USERNAME": "your-bot-user",
        "TAIGA_PASSWORD": "your-bot-password"
      }
    }
  }
}
```

### Inspect manually

```bash
npm run inspector
```

## Run with Docker

Build the image:

```bash
docker build -t taiga-mcp-server .
```

This is a stdio MCP server, so it must be run with `-i` (interactive, keeps stdin open) and `--rm`; credentials are passed as env vars:

```bash
docker run -i --rm \
  -e TAIGA_USERNAME=your-bot-user \
  -e TAIGA_PASSWORD=your-bot-password \
  taiga-mcp-server
```

Or with an env file:

```bash
docker run -i --rm --env-file .env taiga-mcp-server
```

MCP client config using Docker instead of a local Node install:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "TAIGA_USERNAME",
        "-e", "TAIGA_PASSWORD",
        "taiga-mcp-server"
      ],
      "env": {
        "TAIGA_USERNAME": "your-bot-user",
        "TAIGA_PASSWORD": "your-bot-password"
      }
    }
  }
}
```

(`-e TAIGA_USERNAME` without a value forwards the variable from the `env` block above into the container.)

## Tools

| Tool | Description |
|---|---|
| `taiga_whoami` | Current authenticated Taiga user |
| `taiga_list_projects` / `taiga_get_project` | Browse projects; project detail includes statuses, priorities, types, members |
| `taiga_list_user_stories` / `taiga_get_user_story` / `taiga_create_user_story` / `taiga_update_user_story` / `taiga_delete_user_story` / `taiga_bulk_create_user_stories` | Backlog items |
| `taiga_list_tasks` / `taiga_get_task` / `taiga_create_task` / `taiga_update_task` / `taiga_delete_task` | Tasks under user stories |
| `taiga_list_issues` / `taiga_get_issue` / `taiga_create_issue` / `taiga_update_issue` / `taiga_delete_issue` | Bugs/questions/enhancements |
| `taiga_list_epics` / `taiga_get_epic` / `taiga_create_epic` / `taiga_update_epic` / `taiga_delete_epic` / `taiga_link_user_story_to_epic` | Epics |
| `taiga_list_milestones` / `taiga_get_milestone` / `taiga_get_milestone_stats` / `taiga_create_milestone` / `taiga_update_milestone` / `taiga_delete_milestone` | Sprints |
| `taiga_list_memberships` | Project members and roles |
| `taiga_add_comment` / `taiga_list_comments` | Comment threads on stories/tasks/issues/epics |
| `taiga_search` | Free-text search across a project |

Items that have a project-scoped reference number in the Taiga UI (e.g. "US #42") can be fetched/updated/deleted either by that `project` + `ref` pair or by their internal numeric `id` — whichever you have on hand. Updates automatically handle Taiga's optimistic-concurrency `version` field, so you never need to track it yourself.

## Development

```bash
npm run dev     # tsx watch
npm run build   # tsc
npm run clean
```
