import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable, type Schedule } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
} from "ai";
import { z } from "zod";

// Helper to build GitHub headers with optional auth
function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cf-pr-review-agent",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

const SYSTEM_PROMPT = `You are a PR Review Agent — an autonomous code reviewer that analyzes GitHub pull requests.

When a user gives you a PR (as a URL like https://github.com/owner/repo/pull/123 or shorthand like owner/repo#123), follow this workflow:

1. First, call fetchPR to get the PR metadata (title, description, author, changed files).
2. Then, call fetchDiff to get the actual code changes.
3. Analyze the diff yourself. Focus on:
   - Bugs and logic errors
   - Security vulnerabilities (SQL injection, XSS, hardcoded secrets, etc.)
   - Performance issues (N+1 queries, unnecessary re-renders, O(n²) where O(n) is possible)
   - Missing error handling or edge cases
   - Code style and readability issues
4. Skip trivial files: lockfiles (package-lock.json, yarn.lock), generated code, .gitignore changes, pure formatting/whitespace changes.
5. For each issue found, specify:
   - The file and approximate line from the diff
   - Severity: 🔴 Critical, 🟡 Warning, 🔵 Suggestion
   - A clear explanation of the problem
   - A suggested fix
6. End with a summary: overall assessment, number of issues by severity, and whether you'd approve or request changes.
7. After presenting the review, ask if the user wants to post it to GitHub. If yes, call postReview.

If the user asks you to save their GitHub token, use the setGithubToken tool.

Be direct and technical. Don't pad your review with generic praise — focus on actionable findings.
If the diff is clean, say so briefly.`;

export class ChatAgent extends AIChatAgent<Env> {
  waitForMcpConnections = true;

  onStart() {
    // Create tables on first launch
    this.sql`
      CREATE TABLE IF NOT EXISTS github_tokens (token TEXT)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS reviews (
        repo TEXT,
        pr_number INTEGER,
        summary TEXT,
        created_at TEXT
      )
    `;

    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200,
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      },
    });
  }

  @callable()
  async addServer(name: string, url: string, host: string) {
    return await this.addMcpServer(name, url, { callbackHost: host });
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  // Helper to get stored GitHub token
  private getToken(): string | undefined {
    const rows = [...this.sql<{ token: string }>`SELECT token FROM github_tokens LIMIT 1`];
    return rows[0]?.token;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    // Load past reviews for context
    const reviewRows = [...this.sql<{ repo: string; pr_number: number; summary: string }>`
      SELECT repo, pr_number, summary FROM reviews ORDER BY created_at DESC LIMIT 5
    `];
    const pastReviews = reviewRows
      .map((r) => `- ${r.repo}#${r.pr_number}: ${r.summary}`)
      .join("\n");

    const systemPrompt = pastReviews
      ? `${SYSTEM_PROMPT}\n\nYour recent review history (reference if reviewing the same repo):\n${pastReviews}`
      : SYSTEM_PROMPT;

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: systemPrompt,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
      }),
      tools: {
        ...mcpTools,

        // ── Tool: Fetch PR metadata ──────────────────────────────
        fetchPR: tool({
          description:
            "Fetch metadata for a GitHub pull request including title, description, author, and list of changed files.",
          inputSchema: z.object({
            owner: z.string().describe("Repository owner or org"),
            repo: z.string().describe("Repository name"),
            prNumber: z.number().describe("Pull request number"),
          }),
          execute: async ({ owner, repo, prNumber }) => {
            try {
              const token = this.getToken();
              const headers = githubHeaders(token);

              const prRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
                { headers }
              );
              if (!prRes.ok) {
                return { error: `GitHub API returned ${prRes.status}: ${prRes.statusText}` };
              }
              const pr = (await prRes.json()) as any;

              const filesRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
                { headers }
              );
              if (!filesRes.ok) {
                return { error: `Failed to fetch files: ${filesRes.status}` };
              }
              const files = (await filesRes.json()) as any[];

              return {
                title: pr.title,
                description: pr.body || "(no description)",
                author: pr.user?.login,
                state: pr.state,
                baseBranch: pr.base?.ref,
                headBranch: pr.head?.ref,
                additions: pr.additions,
                deletions: pr.deletions,
                changedFiles: pr.changed_files,
                files: files.map((f: any) => ({
                  filename: f.filename,
                  status: f.status,
                  additions: f.additions,
                  deletions: f.deletions,
                })),
              };
            } catch (err: any) {
              return { error: `Failed to fetch PR: ${err.message}` };
            }
          },
        }),

        // ── Tool: Fetch raw diff ─────────────────────────────────
        fetchDiff: tool({
          description:
            "Fetch the raw code diff for a GitHub pull request. Call this after fetchPR to see the actual changes.",
          inputSchema: z.object({
            owner: z.string().describe("Repository owner or org"),
            repo: z.string().describe("Repository name"),
            prNumber: z.number().describe("Pull request number"),
          }),
          execute: async ({ owner, repo, prNumber }) => {
            try {
              const token = this.getToken();
              const headers = {
                ...githubHeaders(token),
                Accept: "application/vnd.github.v3.diff",
              };

              const res = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
                { headers }
              );
              if (!res.ok) {
                return { error: `GitHub API returned ${res.status}: ${res.statusText}` };
              }
              const diff = await res.text();

              // Truncate large diffs to stay within LLM context
              const maxLen = 15000;
              if (diff.length > maxLen) {
                return {
                  diff: diff.slice(0, maxLen),
                  truncated: true,
                  totalLength: diff.length,
                  note: "Diff was truncated. Focus your review on the files shown.",
                };
              }
              return { diff, truncated: false };
            } catch (err: any) {
              return { error: `Failed to fetch diff: ${err.message}` };
            }
          },
        }),

        // ── Tool: Post review (requires approval) ────────────────
        postReview: tool({
          description:
            "Post a code review to a GitHub pull request. This will ask for user confirmation before posting.",
          inputSchema: z.object({
            owner: z.string().describe("Repository owner or org"),
            repo: z.string().describe("Repository name"),
            prNumber: z.number().describe("Pull request number"),
            reviewBody: z.string().describe("The full review text to post"),
            event: z
              .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
              .describe("Review verdict"),
          }),
          // Always require approval before posting
          needsApproval: async () => true,
          execute: async ({ owner, repo, prNumber, reviewBody, event }) => {
            try {
              const token = this.getToken();
              if (!token) {
                return {
                  error:
                    "No GitHub token set. Please provide one first by saying: save my github token ghp_...",
                };
              }

              const res = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
                {
                  method: "POST",
                  headers: {
                    ...githubHeaders(token),
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ body: reviewBody, event }),
                }
              );

              if (!res.ok) {
                const errText = await res.text();
                return { error: `GitHub API error ${res.status}: ${errText}` };
              }

              const review = (await res.json()) as any;

              // Save to review history
              const summary = reviewBody.slice(0, 300);
              this.sql`
                INSERT INTO reviews (repo, pr_number, summary, created_at)
                VALUES (${`${owner}/${repo}`}, ${prNumber}, ${summary}, ${new Date().toISOString()})
              `;

              return {
                success: true,
                message: `Review posted to ${owner}/${repo}#${prNumber}`,
                reviewUrl: review.html_url,
              };
            } catch (err: any) {
              return { error: `Failed to post review: ${err.message}` };
            }
          },
        }),

        // ── Tool: Save GitHub token ──────────────────────────────
        setGithubToken: tool({
          description:
            "Save a GitHub personal access token for API authentication. Needed for private repos and posting reviews.",
          inputSchema: z.object({
            token: z.string().describe("GitHub personal access token (ghp_...)"),
          }),
          execute: async ({ token }) => {
            try {
              this.sql`DELETE FROM github_tokens`;
              this.sql`INSERT INTO github_tokens (token) VALUES (${token})`;
              return { success: true, message: "GitHub token saved securely." };
            } catch (err: any) {
              return { error: `Failed to save token: ${err.message}` };
            }
          },
        }),
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;