import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const CONFIG = {
  githubToken: process.env.GITHUB_TOKEN || "",
  allowedRepos: (process.env.ALLOWED_REPOSITORIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  allowDirectMain: process.env.ALLOW_DIRECT_MAIN_PUSH === "true",
};

function validateRepo(owner, repo) {
  const fullName = `${owner}/${repo}`;
  if (!CONFIG.allowedRepos.includes(fullName)) {
    throw new Error(
      `Repository '${fullName}' is not in the allowed list. Allowed: ${CONFIG.allowedRepos.join(", ") || "(none)"}`
    );
  }
}

function validatePath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("..")) throw new Error("Path traversal detected");
  if (normalized.startsWith("/")) throw new Error("Absolute paths not allowed");
}

function sanitizeForLog(msg) {
  return msg
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, "***REDACTED***")
    .replace(/github_pat_[a-zA-Z0-9_]{36,}/g, "***REDACTED***")
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/gi, "Bearer ***REDACTED***");
}

class GitHubClient {
  constructor(token) { this.token = token; this.baseUrl = "https://api.github.com"; }

  async request(method, path, body = null) {
    if (!this.token) throw new Error("GITHUB_TOKEN is not configured");
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gpt-github-bridge/1.0",
    };
    const options = { method, headers };
    if (body) { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(body); }
    const res = await fetch(`${this.baseUrl}${path}`, options);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    if (!res.ok) {
      const err = new Error(`GitHub API ${res.status}: ${data.message || text}`);
      err.status = res.status; err.githubMessage = data.message; err.githubErrors = data.errors;
      throw err;
    }
    return { status: res.status, data };
  }

  async getRepo(owner, repo) {
    const { data } = await this.request("GET", `/repos/${owner}/${repo}`);
    return { fullName: data.full_name, defaultBranch: data.default_branch, permissions: data.permissions };
  }

  async getRef(owner, repo, ref) {
    const { data } = await this.request("GET", `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(ref)}`);
    return { ref: data.ref, sha: data.object.sha };
  }

  async getContent(owner, repo, path, ref) {
    try {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const { data } = await this.request("GET", `/repos/${owner}/${repo}/contents/${path}${q}`);
      return { path: data.path, sha: data.sha, size: data.size, content: data.content ? Buffer.from(data.content, "base64").toString("utf-8") : null, exists: true };
    } catch (err) {
      if (err.status === 404) return { path, sha: null, size: 0, content: null, exists: false };
      throw err;
    }
  }

  async createBranch(owner, repo, branch, baseSha) {
    const { data } = await this.request("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
    return { ref: data.ref, sha: data.object.sha };
  }

  async upsertFile(owner, repo, branch, path, content, message, sha = null) {
    const body = { message, content: Buffer.from(content, "utf-8").toString("base64"), branch };
    if (sha) body.sha = sha;
    const { data } = await this.request("PUT", `/repos/${owner}/${repo}/contents/${path}`, body);
    return { path: data.content.path, sha: data.content.sha, commitSha: data.commit.sha, commitUrl: data.commit.html_url };
  }

  async createPR(owner, repo, head, base, title, body, draft = true) {
    const { data } = await this.request("POST", `/repos/${owner}/${repo}/pulls`, { title, head, base, body, draft });
    return { number: data.number, url: data.html_url, state: data.state, draft: data.draft, head: data.head.ref, base: data.base.ref };
  }
}

const github = new GitHubClient(CONFIG.githubToken);
const server = new McpServer({ name: "gpt-github-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });

server.tool("get_repository", "Get GitHub repo metadata: default branch, permissions, latest commit",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => {
    validateRepo(owner, repo);
    const info = await github.getRepo(owner, repo);
    const mainRef = await github.getRef(owner, repo, `heads/${info.defaultBranch}`);
    return { content: [{ type: "text", text: JSON.stringify({ ...info, latestCommitSha: mainRef.sha, writable: true, pullRequestEnabled: true }, null, 2) }] };
  }
);

server.tool("read_file", "Read a file from a GitHub repository",
  { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional() },
  async ({ owner, repo, path, ref }) => {
    validateRepo(owner, repo); validatePath(path);
    const result = await github.getContent(owner, repo, path, ref);
    const display = result.content && result.content.length > 10000
      ? result.content.substring(0, 10000) + `\n...(truncated, ${result.content.length} total chars)`
      : result.content;
    return { content: [{ type: "text", text: JSON.stringify({ ...result, content: display }, null, 2) }] };
  }
);

server.tool("create_branch", "Create a new branch from the default branch",
  { owner: z.string(), repo: z.string(), branch: z.string(), base: z.string().optional() },
  async ({ owner, repo, branch, base }) => {
    validateRepo(owner, repo);
    const repoInfo = await github.getRepo(owner, repo);
    const baseBranch = base || repoInfo.defaultBranch;
    const baseRef = await github.getRef(owner, repo, `heads/${baseBranch}`);
    const result = await github.createBranch(owner, repo, branch, baseRef.sha);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, repository: `${owner}/${repo}`, branch, base: baseBranch, sha: result.sha }, null, 2) }] };
  }
);

server.tool("upsert_file", "Create or update a single file. NEVER use on main branch — always use a feature branch",
  { owner: z.string(), repo: z.string(), branch: z.string(), path: z.string(), content: z.string(), commit_message: z.string(), expected_sha: z.string().nullable().optional() },
  async ({ owner, repo, branch, path, content, commit_message, expected_sha }) => {
    validateRepo(owner, repo); validatePath(path);
    if (!CONFIG.allowDirectMain) {
      const repoInfo = await github.getRepo(owner, repo);
      if (branch === repoInfo.defaultBranch) throw new Error(`Direct pushes to default branch '${branch}' are not allowed. Use a feature branch.`);
    }
    let sha = expected_sha || null;
    if (!sha) { const existing = await github.getContent(owner, repo, path, branch); if (existing.exists) sha = existing.sha; }
    const result = await github.upsertFile(owner, repo, branch, path, content, commit_message, sha);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, filePath: result.path, commitSha: result.commitSha, commitUrl: result.commitUrl, operation: sha ? "updated" : "created" }, null, 2) }] };
  }
);

server.tool("create_pull_request", "Create a Draft Pull Request",
  { owner: z.string(), repo: z.string(), head: z.string(), base: z.string(), title: z.string(), body: z.string(), draft: z.boolean().optional() },
  async ({ owner, repo, head, base, title, body, draft = true }) => {
    validateRepo(owner, repo);
    const result = await github.createPR(owner, repo, head, base, title, body, draft);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ...result }, null, 2) }] };
  }
);

server.tool("publish_skill", "ONE-CLICK SKILL UPLOAD: Creates branch, commits all files, opens Draft PR — all at once",
  {
    owner: z.string(), repo: z.string(), skill_name: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Max 50 files"),
    commit_message: z.string().optional(), pr_title: z.string().optional(), pr_body: z.string().optional(), target_directory: z.string().optional(),
  },
  async ({ owner, repo, skill_name, files, commit_message, pr_title, pr_body, target_directory }) => {
    validateRepo(owner, repo);
    if (!files || files.length === 0) throw new Error("At least one file required");
    if (files.length > 50) throw new Error("Max 50 files per call");
    files.forEach(f => validatePath(f.path));

    const repoInfo = await github.getRepo(owner, repo);
    const baseRef = await github.getRef(owner, repo, `heads/${repoInfo.defaultBranch}`);
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const branchName = `gpt/upload-${skill_name}-${ts}`;

    let branchCreated = false, commitSha = null;
    const changedFiles = [], steps = [];

    try {
      await github.createBranch(owner, repo, branchName, baseRef.sha);
      branchCreated = true; steps.push({ step: "create_branch", status: "ok", branch: branchName });

      for (const file of files) {
        const fp = target_directory ? `${target_directory.replace(/\/$/, "")}/${file.path}` : file.path;
        const r = await github.upsertFile(owner, repo, branchName, fp, file.content, commit_message || `Upload ${skill_name}: ${file.path}`, null);
        commitSha = r.commitSha; changedFiles.push(fp);
        steps.push({ step: "upsert_file", status: "ok", path: fp, sha: r.sha });
      }

      const pr = await github.createPR(owner, repo, branchName, repoInfo.defaultBranch,
        pr_title || `[GPT] Upload ${skill_name}`,
        pr_body || `Uploaded by GPT via gpt-github-bridge.\n\n### Files\n${files.map(f => `- \`${f.path}\``).join("\n")}`,
        true);
      steps.push({ step: "create_pr", status: "ok", prNumber: pr.number });

      return { content: [{ type: "text", text: JSON.stringify({ success: true, repository: `${owner}/${repo}`, branch: branchName, commitSha, pullRequestNumber: pr.number, pullRequestUrl: pr.url, changedFiles, steps }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, failedStep: steps[steps.length-1]?.step || "create_branch", githubStatus: err.status, githubMessage: err.githubMessage || err.message, completedSteps: steps, retryable: err.status !== 422 }, null, 2) }], isError: true };
    }
  }
);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "gpt-github-bridge", version: "1.0.0", allowedRepos: CONFIG.allowedRepos, hasToken: !!CONFIG.githubToken });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[MCP Error]", sanitizeForLog(err.message));
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: req.body?.id || null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`gpt-github-bridge running on port ${PORT}`);
  console.log(`Allowed repos: ${CONFIG.allowedRepos.join(", ") || "(none)"}, Token: ${!!CONFIG.githubToken}`);
});

export default app;
