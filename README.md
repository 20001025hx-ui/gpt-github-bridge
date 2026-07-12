# GPT-GitHub Bridge

MCP server bridging ChatGPT to GitHub with full write access.

## Tools

- `get_repository` — Get repo metadata and permissions
- `read_file` — Read a file from a repo
- `create_branch` — Create a new branch
- `upsert_file` — Create or update a single file
- `create_pull_request` — Create a Draft PR
- `publish_skill` — One-click skill upload: branch → commit → PR

## Deploy

### Render (recommended)

1. Fork this repo
2. Go to https://render.com → New Web Service
3. Connect your fork
4. Set environment variables:
   - `GITHUB_TOKEN` — your fine-grained PAT
   - `ALLOWED_REPOSITORIES` — comma-separated list of allowed repos
5. Deploy

### Environment Variables

```
GITHUB_TOKEN=github_pat_xxx
ALLOWED_REPOSITORIES=20001025hx-ui/teacher-skill
ALLOW_DIRECT_MAIN_PUSH=false
```

## Connect to ChatGPT

1. ChatGPT → Settings → Connectors → Create
2. Name: `GitHub Write`
3. MCP Server URL: `https://your-app.onrender.com/mcp`
4. Create

## Security

- Repository whitelist: only listed repos can be modified
- No direct main pushes: all writes go through feature branches + Draft PRs
- SHA verification: prevents overwriting concurrent changes
- Token never appears in logs or responses
