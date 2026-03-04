# PR Review Agent

An AI-powered code review agent built on [Cloudflare's Agents platform](https://developers.cloudflare.com/agents/). Paste a GitHub PR URL into the chat and the agent fetches the PR, reads the diff, identifies bugs and issues, and can post the review back to GitHub with your approval.

**Live:** https://pr-review-agent.talhamasood1011.workers.dev

## What it does

You give it a GitHub PR link (or shorthand like `owner/repo#123`). The agent then:

1. Calls the GitHub API to pull PR metadata — title, description, author, list of changed files
2. Fetches the raw diff for the PR
3. Reads through the changes, skipping trivial files like lockfiles and generated code
4. Identifies bugs, security issues, performance problems, and style issues — each tagged with a severity level
5. Presents a structured review in the chat
6. Offers to post the review to GitHub, which triggers a confirmation dialog (you approve or reject before anything gets posted)

You can also save a GitHub token so the agent can access private repos and post reviews on your behalf.

## Agentic features

- **Multi-step tool use** — the agent autonomously chains tool calls (fetch metadata → fetch diff → analyze → offer to post), deciding what to do at each step based on the previous result
- **Decision-making** — inspects the file list and decides which files are worth reviewing vs. which to skip
- **Human-in-the-loop** — the `postReview` tool requires explicit user approval before executing, using the Agents SDK's built-in approval flow
- **Persistent memory** — past reviews are stored in a SQLite database (built into the Durable Object) and loaded into context for future reviews, so the agent can reference prior findings on the same repo

## Assignment Requirements

| Requirement | What's used |
|---|---|
| LLM | GLM-4.7-Flash on Workers AI |
| Workflow / coordination | Agents SDK (`AIChatAgent`) on Durable Objects, orchestrating a multi-step tool pipeline |
| User input via chat | WebSocket-based React chat UI using the `useAgentChat` hook |
| Memory / state | Durable Object SQLite for review history and GitHub token storage |

## Tools

- **fetchPR** — hits `GET /repos/{owner}/{repo}/pulls/{number}` to get PR metadata
- **fetchDiff** — hits the same endpoint with `Accept: application/vnd.github.v3.diff` to get the raw diff
- **postReview** — `POST /repos/{owner}/{repo}/pulls/{number}/reviews` — requires user approval before executing
- **setGithubToken** — saves a GitHub PAT in the Durable Object's SQLite database

## Running locally

```bash
git clone https://github.com/YOUR_USERNAME/pr-review-agent.git
cd pr-review-agent
npm install
npm start
```

Note: the AI binding uses `"remote": true` in `wrangler.jsonc`, so you need a Cloudflare account. No API keys are needed — Workers AI is included.

## Deploying

```bash
npm run deploy
```

This builds the Vite frontend and deploys everything to Cloudflare Workers.

## Project structure

```
src/
├── server.ts    # Agent: system prompt, tool definitions, state/memory
├── app.tsx      # Chat UI with tool approval and MCP panel
├── client.tsx   # React entry point
└── styles.css   # Tailwind + Kumo theme
```

## Stack

- Cloudflare Workers + Durable Objects
- Cloudflare Agents SDK (`AIChatAgent`)
- Workers AI via `workers-ai-provider`
- Vercel AI SDK v6
- React + Kumo (Cloudflare's component library) + Vite