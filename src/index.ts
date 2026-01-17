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
import os from "os";

// Load environment variables
dotenv.config();

const execAsync = util.promisify(exec);

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 3000;

const REPO_URLS: Record<string, string | undefined> = {
  "revm": process.env.URL_REVM,
  "alloy": process.env.URL_ALLOY,
  "reth": process.env.URL_RETH
};

const CACHE_DIR = path.join(process.cwd(), "repos");
const LOCAL_PATHS: Record<string, string> = {};

// =============================================================================
// REPO MANAGEMENT
// =============================================================================

async function ensureRepo(name: string, remoteUrl: string) {
  const localPath = path.join(CACHE_DIR, name);
  LOCAL_PATHS[name] = localPath;

  console.log(`[Repo: ${name}] Preparing...`);

  try {
    try {
      await fs.access(path.join(localPath, ".git"));
      console.log(`[Repo: ${name}] Local cache found at ${localPath}`);
      // Optional: Pull latest changes
      // console.log(`[Repo: ${name}] Pulling latest changes...`);
      // await execAsync("git pull", { cwd: localPath });
    } catch (e) {
      console.log(`[Repo: ${name}] Cache missing. Cloning from remote...`);
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await execAsync(`git clone ${remoteUrl} ${name}`, { cwd: CACHE_DIR });
      console.log(`[Repo: ${name}] Clone success!`);
    }
  } catch (error) {
    console.error(`[Repo: ${name}] Critical Error during setup:`, error);
  }
}

// =============================================================================
// MCP SERVER SETUP
// =============================================================================

const server = new McpServer({
  name: "altius-cloud-mcp",
  version: "1.0.0",
});

function getPath(repoName: string) {
  const p = LOCAL_PATHS[repoName];
  if (!p) throw new Error(`Repository ${repoName} is not available.`);
  return p;
}

// Change 1: utilize server.tool instead of server.registerTool
// Tool: List Repos
server.tool(
  "list_repos", 
  {}, // No input arguments
  async () => {
    const list = Object.keys(LOCAL_PATHS).map(k => `- ${k}`).join("\n");
    return { content: [{ type: "text", text: `Active Repositories:\n${list}` }] };
  }
);

// Tool: Search Code
server.tool(
  "search_code",
  {
    repo: z.enum(["revm", "alloy", "reth"]),
    query: z.string(),
    branch: z.string().optional(),
    path_filter: z.string().optional()
  },
  // The 'args' object is now correctly typed thanks to Zod inference
  async ({ repo, query, branch, path_filter }) => {
    const cwd = getPath(repo);
    const ref = branch || "HEAD";
    const filter = path_filter || ".";
    
    // Safety check for command injection is recommended here in production
    // Using simple git grep
    const cmd = `git grep -nI "${query}" ${ref} -- ${filter} | head -n 50`;
    try {
      const { stdout } = await execAsync(cmd, { cwd });
      return { content: [{ type: "text", text: stdout || "No matches." }] };
    } catch (e) {
      return { content: [{ type: "text", text: "No matches found." }] };
    }
  }
);

// Tool: Read File
server.tool(
  "read_file",
  {
    repo: z.enum(["revm", "alloy", "reth"]),
    path: z.string(),
    branch: z.string().optional()
  },
  async ({ repo, path: filePath, branch }) => {
    const cwd = getPath(repo);
    const ref = branch || "HEAD";
    
    // Basic path traversal prevention
    if (filePath.includes("..")) {
      return { content: [{ type: "text", text: "Invalid path" }], isError: true };
    }

    const cmd = `git show ${ref}:${filePath}`;
    try {
      const { stdout } = await execAsync(cmd, { cwd });
      return { content: [{ type: "text", text: stdout }] };
    } catch (e) {
      return { content: [{ type: "text", text: "File not found." }] };
    }
  }
);

// Tool: List Branches
server.tool(
  "list_branches",
  { repo: z.enum(["revm", "alloy", "reth"]) },
  async ({ repo }) => {
    try {
      const { stdout } = await execAsync("git branch -a", { cwd: getPath(repo) });
      return { content: [{ type: "text", text: stdout }] };
    } catch (e) { 
      return { content: [{ type: "text", text: "Error listing branches" }] }; 
    }
  }
);

// =============================================================================
// HTTP SERVER
// =============================================================================

const app = express();
app.use(cors());

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  console.log("-> Client connected");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) await transport.handlePostMessage(req, res);
});

async function main() {
  console.log("=== Initializing Storage ===");
  for (const [name, url] of Object.entries(REPO_URLS)) {
    if (url) await ensureRepo(name, url);
  }

  app.listen(PORT, () => {
    console.log(`\n=== Altius MCP Running ===`);
    console.log(`> Local Storage: ${CACHE_DIR}`);
    console.log(`> URL: http://localhost:${PORT}/sse`);
  });
}

main();