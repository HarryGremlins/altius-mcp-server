import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

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
// HELPER: SAFE GIT EXECUTION
// =============================================================================

/**
 * Safely execute git commands using spawn to prevent shell injection
 */
async function gitSpawn(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("git", args, { cwd });
    
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => { stdout += data; });
    process.stderr.on("data", (data) => { stderr += data; });

    process.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Handle git grep returning 1 when no matches are found
        if (args.includes("grep") && code === 1) {
            resolve(""); 
        } else {
            reject(new Error(`Git command failed: ${stderr || "Unknown error"}`));
        }
      }
    });

    process.on("error", (err) => reject(err));
  });
}

async function ensureRepo(name: string, remoteUrl: string) {
  const localPath = path.join(CACHE_DIR, name);
  LOCAL_PATHS[name] = localPath;

  console.log(`[Repo: ${name}] Checking status...`);

  try {
    await fs.access(path.join(localPath, ".git"));
    console.log(`[Repo: ${name}] Ready.`);
  } catch (e) {
    console.log(`[Repo: ${name}] Cloning...`);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await gitSpawn(["clone", remoteUrl, name], CACHE_DIR); 
    console.log(`[Repo: ${name}] Cloned.`);
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

// Tool: List Repos
server.tool(
  "list_repos", 
  {}, 
  async () => {
    const list = Object.keys(LOCAL_PATHS).map(k => `- ${k}`).join("\n");
    return { content: [{ type: "text", text: `Active Repositories:\n${list}` }] };
  }
);

// Tool: Search Code (Fixed injection vulnerability)
server.tool(
  "search_code",
  {
    repo: z.enum(["revm", "alloy", "reth"]),
    query: z.string(),
    branch: z.string().optional(),
    path_filter: z.string().optional()
  },
  async ({ repo, query, branch, path_filter }) => {
    const cwd = getPath(repo);
    const ref = branch || "HEAD";
    const filter = path_filter || ".";
    
    // Use spawn args array to prevent shell injection
    // Equivalent to: git grep -nI "query" ref -- filter
    const args = ["grep", "-nI", query, ref, "--", filter];
    
    try {
      // Fetch output safely
      let output = await gitSpawn(args, cwd);
      
      const lines = output.split('\n');
      if (lines.length > 50) {
        output = lines.slice(0, 50).join('\n') + `\n... (${lines.length - 50} more matches)`;
      }
      
      return { content: [{ type: "text", text: output || "No matches." }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// Tool: Read File (Fixed path traversal)
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
    
    // Path traversal check
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return { content: [{ type: "text", text: "Invalid path security check failed." }], isError: true };
    }

    try {
      // git show ref:path
      const output = await gitSpawn(["show", `${ref}:${filePath}`], cwd);
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return { content: [{ type: "text", text: "File not found or error reading." }] };
    }
  }
);

// Tool: List Branches
server.tool(
  "list_branches",
  { repo: z.enum(["revm", "alloy", "reth"]) },
  async ({ repo }) => {
    try {
      const output = await gitSpawn(["branch", "-a"], getPath(repo));
      return { content: [{ type: "text", text: output }] };
    } catch (e) { 
      return { content: [{ type: "text", text: "Error listing branches" }] }; 
    }
  }
);

// =============================================================================
// HTTP SERVER (Multi-Tenant Fix)
// =============================================================================

const app = express();
app.use(cors());

// Map to store Session ID -> Transport
const transports = new Map<string, SSEServerTransport>();

app.get("/", (req, res) => {
  res.send("Altius MCP Server is Running! 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "✅ healthy" });
});

/**
 * SSE Endpoint
 * Initializes a new transport for every connection and stores it.
 */
app.get("/sse", async (req, res) => {
  console.log("-> New SSE Connection initiating...");
  
  const transport = new SSEServerTransport("/messages", res);
  console.log(`-> Session created: ${transport.sessionId}`);
  transports.set(transport.sessionId, transport);

  // Send an SSE comment every 30 seconds to prevent load balancers/Nginx from closing the connection
  const keepAliveInterval = setInterval(() => {
    // Check if the connection is still alive
    if (res.writableEnded || res.closed) {
      clearInterval(keepAliveInterval);
      return;
    }
    // Send an SSE comment line (starting with a colon), which the client will ignore but keeps the connection active
    res.write(": keepalive\n\n");
  }, 30000);

  // Clean up timer and Session when the connection closes
  res.on("close", () => {
    console.log(`-> Session closed: ${transport.sessionId}`);
    clearInterval(keepAliveInterval);
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

/**
 * Messages Endpoint (Client -> Server)
 * Routes messages to the correct transport based on sessionId.
 */
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  
  if (!sessionId) {
    res.status(400).send("Missing sessionId");
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).send("Session not found or expired");
    return;
  }

  await transport.handlePostMessage(req, res);
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