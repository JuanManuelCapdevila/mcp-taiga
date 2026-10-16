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
cp .env.example .env   # then fill in TAIGA_API_URL / TAIGA_USERNAME / TAIGA_PASSWORD
```

Environment variables:

| Variable | Required | Description |
|---|---|---|
| `TAIGA_API_URL` | yes | Base API URL. Use `https://api.taiga.io/api/v1` for Taiga Cloud, or your self-hosted instance's own `/api/v1` path |
| `TAIGA_USERNAME` | yes | Username or email of the Taiga account this server acts as |
| `TAIGA_PASSWORD` | yes | Password for that account |
| `TRANSPORT` | no | `stdio` (default) or `http` — see [Transports](#transports) below |
| `PORT` | no, `http` only | Port to listen on (default `3000`) |
| `MCP_BEARER_TOKEN` | yes, `http` only | The one secret in the system: password on the OAuth login form **and** the static bearer token (`Authorization: Bearer <token>`) for clients that don't speak OAuth |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | yes, `http` only | Fixed client credentials for the OAuth "user-defined client" flow — make these up and paste the same values into the client's connector setup |
| `OAUTH_ALLOWED_REDIRECT_PREFIX` | no, `http` only | Only `redirect_uri`s starting with this are accepted by `/authorize`. Defaults to ChatGPT's connector callback prefix (`https://chatgpt.com/connector/oauth/`) |

The server exits on startup if a required variable for the selected transport is missing.

## Transports

- **stdio** (default): the client spawns this process directly and talks JSON-RPC over stdin/stdout. Use this for local clients — Claude Desktop, Claude Code, `npm run inspector`. No network port is opened.
- **http**: serves [MCP Streamable HTTP](https://modelcontextprotocol.io/) at `POST /mcp` on `$PORT` (plus an unauthenticated `GET /healthz` for platform health checks). Use this to run the server as an always-on remote service behind a host that terminates HTTPS (see CapRover below). `MCP_BEARER_TOKEN` is a simple shared-secret gate in front of the server, not a substitute for Taiga's own per-project permissions described above: anyone who can authenticate (directly with the token, or via the OAuth dance below) can call every tool this server exposes, exactly as the configured Taiga bot user is allowed to.

Two ways to authenticate against `POST /mcp`:

1. **Direct bearer token** — for clients that support a plain static token: send `Authorization: Bearer <MCP_BEARER_TOKEN>` yourself. This is what the stdio-equivalent `curl` examples above use.
2. **OAuth 2.1 (Authorization Code + PKCE)** — for clients that only support OAuth, like ChatGPT's custom connectors (no plain API-key option in their UI). The server implements a minimal, single-tenant authorization server (`src/oauth.ts`):
   - `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` — metadata so clients can auto-discover the endpoints below.
   - `GET/POST /authorize` — shows a one-field login page; the "password" is `MCP_BEARER_TOKEN`.
   - `POST /token` — exchanges the authorization code (with PKCE) for an access token, which **is** `MCP_BEARER_TOKEN`.

   There's intentionally no dynamic client registration and no refresh tokens — `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` are a fixed pair you invent and enter manually on both sides, and the issued token has a long expiry instead of rotating. This is a pragmatic simplification for a single operator/single Taiga identity, not a general-purpose multi-tenant OAuth server.

### Run with an MCP client (e.g. Claude Code / Claude Desktop)

Add to your client's MCP server config:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-taiga/dist/index.js"],
      "env": {
        "TAIGA_API_URL": "https://api.taiga.io/api/v1",
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
  -e TAIGA_API_URL=https://api.taiga.io/api/v1 \
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
        "-e", "TAIGA_API_URL",
        "-e", "TAIGA_USERNAME",
        "-e", "TAIGA_PASSWORD",
        "taiga-mcp-server"
      ],
      "env": {
        "TAIGA_API_URL": "https://api.taiga.io/api/v1",
        "TAIGA_USERNAME": "your-bot-user",
        "TAIGA_PASSWORD": "your-bot-password"
      }
    }
  }
}
```

(`-e TAIGA_USERNAME` without a value forwards the variable from the `env` block above into the container.)

### Remote deployment (CapRover) for ChatGPT custom connectors

To run this as an always-on remote MCP server — e.g. so ChatGPT's custom connector settings can reach it — deploy the same image with `TRANSPORT=http`:

1. In CapRover, create a new app (e.g. `taiga-mcp`), enable **HTTPS** and **Force HTTPS** so tokens aren't sent in plaintext.
2. Set the app's **Container HTTP Port** to `3000` (or whatever you set `PORT` to).
3. App Configs → Environment Variables:
   ```
   TAIGA_API_URL=https://api.taiga.io/api/v1
   TAIGA_USERNAME=your-bot-user
   TAIGA_PASSWORD=your-bot-password
   TRANSPORT=http
   PORT=3000
   MCP_BEARER_TOKEN=<generate with: openssl rand -hex 32>
   OAUTH_CLIENT_ID=<generate with: openssl rand -hex 16>
   OAUTH_CLIENT_SECRET=<generate with: openssl rand -hex 32>
   ```
4. Deploy the image built in the GHCR steps above (CapRover → Deploy from Docker Registry, point it at `ghcr.io/<owner>/<image>:latest`).
5. Sanity-check it's up:
   ```bash
   curl https://taiga-mcp.<your-caprover-domain>/healthz
   curl https://taiga-mcp.<your-caprover-domain>/.well-known/oauth-authorization-server
   ```

**Connecting ChatGPT (custom connector, OAuth):**

1. ChatGPT → Settings → Connectors → Create → fill in Name/Description.
2. **Connection → URL del servidor**: `https://taiga-mcp.<your-caprover-domain>/mcp` (the MCP server's own URL — **not** `TAIGA_API_URL`).
3. **Autenticación**: `OAuth`.
4. Click **Reintentar la detección** — it should now auto-fill the authorization/token endpoints from this server's `/.well-known/oauth-authorization-server`. If it doesn't, fill "Configuración avanzada de OAuth" manually with the `/authorize`, `/token` and `/.well-known/oauth-authorization-server` URLs above.
5. **Registro del cliente**: "Cliente OAuth definido por el usuario" → paste your `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` into the matching fields.
6. Save, then authorize: ChatGPT redirects to this server's login page — enter `MCP_BEARER_TOKEN` as the "password" to complete the connection.

`GET /healthz` (no auth) is there for CapRover's own health check if you want to configure one.

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
