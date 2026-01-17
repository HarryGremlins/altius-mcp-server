import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { exec } from "child_process";
import util from "util";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const execAsync = util.promisify(exec);

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 3000;

// Map repository keys (used by LLM) to local filesystem paths (from .env)
const REPO_MAP: Record<string, string | undefined> = {
  "revm": process.env.PATH_REVM || "https://github.com/Altius-Labs/altius-revm",
  "alloy": process.env.PATH_ALLOY || "https://github.com/Altius-Labs/altius-alloy-evm",
  "reth": process.env.PATH_RETH || "https://github.com/Altius-Labs/altius-reth",
};

// =============================================================================
// REPO MANAGEMENT
// =============================================================================

/**
 * Validates and updates a single repository.
 */
async function syncRepo(name: string, repoPath: string) {
  console.log(`[Repo: ${name}] Checking path: ${repoPath}`);

  try {
    // 1. Check existence
    await fs.access(repoPath);

    // 2. Check if it's a git repo
    const gitCheck = await execAsync("git rev-parse --is-inside-work-tree", { cwd: repoPath });
    if (!gitCheck.stdout.trim()) {
      throw new Error("Path exists but is not a git repository");
    }

    // 3. Attempt git pull
    console.log(`[Repo: ${name}] Pulling latest changes...`);
    try {
      const { stdout } = await execAsync("git pull", { cwd: repoPath });
      console.log(`[Repo: ${name}] Update success: ${stdout.trim().split('\n')[0]}`);
    } catch (pullError) {
      console.warn(`[Repo: ${name}] 'git pull' failed (offline or dirty tree). Serving current version.`);
    }

  } catch (error) {
    console.error(`[Repo: ${name}] Critical Error: Path invalid or inaccessible.`);
    process.exit(1);
  }
}

/**
 * Helper to get repo path or throw error if invalid
 */
function getRepoPath(repoName: string): string {
  const targetPath = REPO_MAP[repoName];
  if (!targetPath) {
    const available = Object.keys(REPO_MAP).join(", ");
    throw new Error(`Unknown repository: '${repoName}'. Available: ${available}`);
  }
  return targetPath;
}

// =============================================================================
// MCP SERVER SETUP
// =============================================================================

const server = new McpServer({
  name: "altius-multi-repo-mcp",
  version: "1.0.0",
});

// Tool 1: List Repositories
server.registerTool(
  "list_repos",
  {
    description: "List all configured repositories available for access.",
    inputSchema: {}
  },
  async () => {
    const list = Object.entries(REPO_MAP)
      .map(([k, v]) => `- **${k}**: \`${v}\``)
      .join("\n");
    return { content: [{ type: "text", text: list }] };
  }
);

// Tool 2: Search Code (Multi-repo + Branch support)
server.registerTool(
  "search_code",
  {
    description: "Search for code patterns using git grep in a specific repo.",
    inputSchema: {
      repo: z.enum(["revm", "alloy", "reth"]).describe("The target repository name"),
      query: z.string().describe("The search string or regex"),
      branch: z.string().optional().describe("Branch name or commit hash (default: HEAD)"),
      path_filter: z.string().optional().describe("Limit search to specific subdirectory")
    }
  },
  async ({ repo, query, branch, path_filter }) => {
    const repoPath = getRepoPath(repo);
    const targetRef = branch || "HEAD";
    const filter = path_filter || ".";

    // git grep -n (line number) -I (no binary)
    const cmd = `git grep -nI "${query}" ${targetRef} -- ${filter} | head -n 50`;

    try {
      const { stdout } = await execAsync(cmd, { cwd: repoPath });
      return {
        content: [{ type: "text", text: stdout || "No matches found." }]
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: "No matches found." }]
      };
    }
  }
);

// Tool 3: Read File (Multi-repo + Branch support)
server.registerTool(
  "read_file",
  {
    description: "Read a file from a specific repo and branch.",
    inputSchema: {
      repo: z.enum(["revm", "alloy", "reth"]).describe("The target repository name"),
      path: z.string().describe("Relative path to the file"),
      branch: z.string().optional().describe("Branch name or commit hash (default: HEAD)")
    }
  },
  async ({ repo, path: filePath, branch }) => {
    const repoPath = getRepoPath(repo);
    const targetRef = branch || "HEAD";

    if (filePath.includes("..")) {
      return { content: [{ type: "text", text: "Invalid path." }], isError: true };
    }

    // git show <ref>:<path>
    const cmd = `git show ${targetRef}:${filePath}`;

    try {
      const { stdout } = await execAsync(cmd, { cwd: repoPath });
      return {
        content: [{ type: "text", text: stdout }]
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: File not found in ${repo} at ${targetRef}` }]
      };
    }
  }
);

// Tool 4: List Branches
server.registerTool(
  "list_branches",
  {
    description: "List branches for a specific repository.",
    inputSchema: {
      repo: z.enum(["revm", "alloy", "reth"])
    }
  },
  async ({ repo }) => {
    const repoPath = getRepoPath(repo);
    try {
      const { stdout } = await execAsync("git branch -a", { cwd: repoPath });
      return { content: [{ type: "text", text: stdout }] };
    } catch (e) {
      return { content: [{ type: "text", text: "Error listing branches." }] };
    }
  }
);

// =============================================================================
// HTTP / SSE SERVER
// =============================================================================

const app = express();
app.use(cors());

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  console.log("-> Client connected via SSE");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active connection");
  }
});

// Initialize all repos then start server
async function start() {
  console.log("\n=== Initializing Repositories ===");
  for (const [name, p] of Object.entries(REPO_MAP)) {
    if (p) await syncRepo(name, p);
  }

  app.listen(PORT, () => {
    console.log(`\n=== Altius Multi-Repo MCP Running ===`);
    console.log(`> Listening on: http://localhost:${PORT}/sse`);
    console.log(`> Managed Repos: ${Object.keys(REPO_MAP).join(", ")}`);
  });
}

start();
