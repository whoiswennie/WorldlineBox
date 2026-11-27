import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import {
  BotDshBrain,
  type BotDshRun,
} from "../../src/main/companion-bot/dsh-brain";
import {
  nativeCallback,
  nativeServiceFixture,
  waitNative,
} from "../fixtures/bot-native-service";
import { createBotNativeHost } from "../fixtures/bot-native-host";

it("authenticates the workspace Session check and returns only the calling companion’s retired roots", async () => {
  let received: Awaited<ReturnType<typeof nativeCallback>> | undefined;
  const f = await nativeServiceFixture(async (input) => {
    expect(input.checkRetiredSessions).toBe(true);
    expect(
      input.workerTools?.some(
        (tool) => tool.name === "workspace_retired_sessions",
      ),
    ).toBe(false);
    received = await nativeCallback(input, "workspace_retired_sessions", {});
    return "收到。";
  });
  try {
    const room = f.service.store
      .conversations()
      .find((value) => value.kind === "direct")!;
    const companion = room.memberIds.find((id) => id !== "user")!;
    f.service.store.taskTransaction((sql) => {
      const insert = sql.prepare(
        "INSERT INTO bot_retired_memory_lanes(native_lane_id,replacement_lane_id,companion_id,conversation_id) VALUES(?,?,?,?)",
      );
      insert.run("old-this", "now-this", companion, room.id);
      insert.run("old-other", "now-other", "other-partner", room.id);
    });
    await f.service.handle({
      type: "message.send",
      conversationId: room.id,
      content: "继续当前话题",
      requestId: "session-retirement-scope",
    });
    await waitNative(() => received !== undefined);
    expect(received).toMatchObject({
      status: 200,
      ok: true,
      result: [BotDshBrain.sessionId("old-this")],
    });
  } finally {
    await f.close();
  }
});

it("excludes retired sessions and their descendants before reading previews or resuming any agent", async () => {
  const modulePath = "../../resources/dsh-bridge/sessions.js";
  const { registerWorkspaceSessions } = await import(modulePath);
  const clean = "wlb-bot-clean",
    old = "wlb-bot-old",
    child = "old-child",
    grandchild = "wlb-bot-old-grandchild";
  const caller = "wlb-bot-caller",
    cwd = "/partner",
    signal = new AbortController().signal;
  const audience = { conversationId: "room", allowedConversationIds: ["room"] };
  const rows = [
    { id: grandchild, parentSession: child, cwd },
    { id: old, cwd },
    { id: clean, cwd },
    { id: child, parentSession: old, cwd: "/child" },
    { id: caller, cwd },
    { id: "outside", cwd: "/other" },
  ].map((header) => ({ header }));
  const open = vi.fn(async (id: string) => ({
    read: async () => ({
      events: [
        {
          seq: 1,
          type: "user/message",
          data: {
            source: { worldlineboxAudience: audience },
            message: {
              content: [
                {
                  type: "text",
                  text: id === clean ? "仍然可见的原话" : id + "原话",
                },
              ],
            },
          },
        },
      ],
    }),
    close: async () => undefined,
  }));
  type Tool = {
    name: string;
    execute(
      args: object,
      execution: object,
    ): Promise<{
      result: {
        items?: { sessionId: string }[];
        messages?: { text: string }[];
      };
    }>;
  };
  const tools = new Map<string, Tool>(),
    create = vi.fn(),
    steer = vi.fn(),
    retiredSessions = vi.fn(async () => [old]);
  const agent = {
    session: { id: caller, header: { cwd } },
    ctx: {
      tools: {
        register(tool: Tool) {
          tools.set(tool.name, tool);
          return () => tools.delete(tool.name);
        },
      },
    },
  };
  const exec = { agent, signal, callId: "call" },
    record = {
      id: caller,
      agent,
      bot: { audience, checkRetiredSessions: true },
    };
  const ctx = {
    get: () => ({ list: async () => rows, open }),
    agents: {
      get: (id: string) => (id === grandchild ? { steer } : undefined),
    },
    sessions: { flush: vi.fn() },
  };
  registerWorkspaceSessions(ctx, record, {
    sessions: new Map(),
    create,
    retiredSessions,
  });
  const list = await tools.get("sessions_list")!.execute({}, exec);
  expect(list.result.items!.map((row) => row.sessionId).sort()).toEqual(
    [caller, clean].sort(),
  );
  expect(
    (await tools.get("sessions_read")!.execute({ sessionId: clean }, exec))
      .result.messages,
  ).toMatchObject([{ text: "仍然可见的原话" }]);
  for (const id of [old, grandchild])
    for (const name of ["sessions_read", "sessions_send", "sessions_wait"]) {
      await expect(
        tools
          .get(name)!
          .execute({ sessionId: id, message: "继续", timeoutMs: 0 }, exec),
      ).rejects.toThrow("outside the companion workspace");
    }
  expect(open.mock.calls.map(([id]) => id)).not.toContain(old);
  expect(open.mock.calls.map(([id]) => id)).not.toContain(grandchild);
  expect(create).not.toHaveBeenCalled();
  expect(steer).not.toHaveBeenCalled();
  retiredSessions.mockResolvedValue([old, clean]);
  await expect(
    tools.get("sessions_read")!.execute({ sessionId: clean }, exec),
  ).rejects.toThrow("outside the companion workspace");
  retiredSessions.mockRejectedValue(new Error("host disconnected"));
  await expect(tools.get("sessions_list")!.execute({}, exec)).rejects.toThrow(
    "host disconnected",
  );
});

it.runIf(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)(
  "filters persisted retired sessions on the actual DSH model wire after a host restart",
  async () => {
    const native = await createBotNativeHost(
      process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!,
    );
    const old = BotDshBrain.sessionId("old"),
      clean = BotDshBrain.sessionId("clean");
    const plan = [
      { name: "sessions_list", args: {} },
      { name: "sessions_read", args: { sessionId: old } },
      {
        name: "sessions_send",
        args: { sessionId: old, message: "do not resume" },
      },
      { name: "sessions_read", args: { sessionId: clean } },
    ];
    const receipts: string[] = [],
      results: string[] = [];
    let stage = "old",
      step = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === "/bot/tool") {
        receipts.push(body.name);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, result: [old] }));
        return;
      }
      const last = body.messages
        .filter((message: { role: string }) => message.role === "tool")
        .at(-1);
      if (last) results.push(JSON.stringify(last.content));
      const next = stage === "current" ? plan[step++] : undefined;
      const delta = next
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-" + step,
                type: "function",
                function: {
                  name: next.name,
                  arguments: JSON.stringify(next.args),
                },
              },
            ],
          }
        : {
            content:
              stage === "old"
                ? "RETIRED-DIARY-FACT"
                : stage === "clean"
                  ? "CLEAN-HUMAN-RECORD"
                  : "FILTER-VERIFIED",
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: next ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Native retirement fixture has no port");
    const baseUrl = "http://127.0.0.1:" + address.port,
      cwd = path.join(native.root, "companion");
    let client = await native.instances.ensureHost(native.instance.id);
    const brain = new BotDshBrain({ getHost: async () => ({ client }) });
    const input = (laneId: string): BotDshRun => ({
      laneId,
      eventId: "event-" + laneId,
      cwd,
      role: "worker",
      workerAccess: "full",
      tools: [],
      callback: { url: baseUrl + "/bot/tool", token: "c".repeat(64) },
      model: {
        apiFormat: "openai_chat",
        model: "session-check",
        baseUrl,
        apiKey: "fixture",
        contextWindow: 32768,
      },
      system: "Workspace fixture",
      prompt: "scenario " + laneId,
      audience: {
        conversationId: "one",
        kind: "direct",
        allowedConversationIds: ["one"],
      },
      checkRetiredSessions: laneId === "current",
    });
    try {
      expect((await brain.run(input("old"))).text).toBe("RETIRED-DIARY-FACT");
      stage = "clean";
      expect((await brain.run(input("clean"))).text).toBe("CLEAN-HUMAN-RECORD");
      await native.instances.stop(native.instance.id);
      client = await native.instances.ensureHost(native.instance.id);
      stage = "current";
      expect((await brain.run(input("current"))).text).toBe("FILTER-VERIFIED");
      expect(receipts).toEqual(Array(4).fill("workspace_retired_sessions"));
      expect(results).toHaveLength(4);
      expect(results[0]).toContain(clean);
      expect(results[0]).not.toContain(old);
      expect(results[1]).toContain("outside the companion workspace");
      expect(results[2]).toContain("outside the companion workspace");
      expect(results[3]).toContain("CLEAN-HUMAN-RECORD");
      expect(results.join("\n")).not.toContain("RETIRED-DIARY-FACT");
    } finally {
      await brain.close();
      await native.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  120000,
);
