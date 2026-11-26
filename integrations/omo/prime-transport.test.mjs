import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parallel Prime workers keep Codex Claude Kimi and Qwen credentials isolated on the wire", async () => {
  // Given account-specific routes and a server that waits for every worker.
  const root = await mkdtemp(join(tmpdir(), "prime-transport-"));
  const captured = new Map();
  let release;
  const allArrived = new Promise((resolve) => { release = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      if (request.method === "GET") return new Response("SSE only", { status: 426 });
      const id = new URL(request.url).pathname.split("/")[1];
      const body = await request.json();
      captured.set(id, { headers: request.headers, body });
      if (captured.size === 7) release();
      await allArrived;
      const text = `OK_${id}`;
      if (id === "qwen") {
        return new Response(`data: ${JSON.stringify({ id: "qwen-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "qwen-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      const events = id.startsWith("codex") ? [
        { type: "response.created", response: { id: `resp_${id}` } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } },
        { type: "response.completed", response: { id: `resp_${id}`, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
      ] : [
        { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const ids = ["codex-a", "codex-b", "claude-a", "claude-b", "kimi-a", "kimi-b", "qwen"];
  const tokens = Object.fromEntries(ids.map((id) => [id, id.startsWith("codex")
    ? `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`
    : id.startsWith("claude") ? `sk-ant-oat-test-${id}` : `kimi-test-${id}`]));
  const providers = Object.fromEntries(ids.map((id) => [id, {
    api: id.startsWith("codex") ? "openai-codex-responses" : id === "qwen" ? "openai-completions" : "anthropic-messages",
    baseUrl: `http://127.0.0.1:${server.port}/${id}`,
    apiKey: tokens[id],
    models: [{ id: id.startsWith("claude") ? "claude-sonnet-4-5" : id.startsWith("codex") ? "gpt-6.1-sol" : "k3", name: id, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  }]));
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers }));
  await writeFile(join(agent, "settings.json"), "{}");
  const children = [];
  try {
    // When every account starts independently, all requests must overlap.
    const results = await Promise.all(ids.map(async (id) => {
      const child = Bun.spawn(["timeout", "60s", process.env.PRIME_AGENT_BIN ?? `${process.env.HOME}/.local/bin/prime-agent`,
        "--offline", "--print", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files",
        "--provider", id, "--model", providers[id].models[0].id, "--thinking", "off",
        "--system-prompt", "Respond directly without tools.", "Say OK."], {
        cwd: root,
        env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: agent, DO_NOT_TRACK: "1" },
        stdout: "pipe", stderr: "pipe",
      });
      children.push(child);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { id, out, err, code };
    }));
    // Then each response and request credential belongs only to its own account.
    expect(captured.size).toBe(7);
    for (const { id, out, err, code } of results) {
      expect(code, `${id}: ${err}`).toBe(0);
      expect(out.trim()).toBe(`OK_${id}`);
      const { headers } = captured.get(id);
      if (id.startsWith("kimi")) {
        expect(headers.get("x-api-key")).toBe(tokens[id]);
        expect(headers.get("authorization")).toBeNull();
      } else {
        expect(headers.get("authorization")).toBe(`Bearer ${tokens[id]}`);
        expect(headers.get("x-api-key")).toBeNull();
      }
      if (id.startsWith("codex")) expect(headers.get("chatgpt-account-id")).toBe(id);
      if (id.startsWith("claude")) expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    }
  } finally {
    release();
    for (const child of children) if (child.exitCode === null) child.kill();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
