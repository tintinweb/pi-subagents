import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-types.js", () => ({
  getAgentConfig: vi.fn((type: string) => (type === "loner" ? { agentMessaging: false } : {})),
}));

import {
  admitStrandedWake,
  agentTakesPart,
  handBack,
  type MessagingHost,
  reportsToMain,
  resetPeerWakes,
  sendMessage,
  setAgentMessagingEnabled,
  setAgentMessagingMaxWakes,
  strandedDropped,
  strandedWakeFailed,
  unwrapForDisplay,
  wrapCoordinatorMessage,
  wrapPeerMessage,
} from "../src/send-message.js";
import { type AgentRecord, type AgentTombstone, isBusy } from "../src/types.js";

function rec(over: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    type: "general-purpose",
    description: "d",
    status: "running",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    compactionCount: 0,
    session: {} as any,
    ...over,
  } as AgentRecord;
}

function fakeHost(records: AgentRecord[], tombstones: AgentTombstone[] = []) {
  const map = new Map(records.map(r => [r.id, r]));
  const steered: { id: string; message: string }[] = [];
  const woken: { id: string; prompt: string }[] = [];
  const toMain: { from: string; wrapped: string; body: string }[] = [];
  const formerOwner: { ownerId: string | undefined; text: string }[] = [];
  const warnings: string[] = [];
  /** Agents, or the main session ("main"), whose active tools lack SendMessage. */
  const withoutTool = new Set<string>();
  const host: MessagingHost = {
    getRecord: id => map.get(id),
    listAgents: () => [...map.values()],
    listTombstones: () => tombstones,
    steer: (id, message) => {
      // As the manager: a busy agent takes a steer.
      const r = map.get(id);
      if (!r || !isBusy(r)) return false;
      steered.push({ id, message });
      return true;
    },
    wake: vi.fn(async (r: AgentRecord, prompt: string) => {
      woken.push({ id: r.id, prompt });
      r.status = "running";
      return r;
    }),
    deliverToMain: (sender, wrapped, body) => { toMain.push({ from: sender.id, wrapped, body }); },
    tell: (ownerId, text) => { formerOwner.push({ ownerId, text }); },
    hasSendMessage: id => !withoutTool.has(id ?? "main"),
    warn: text => { warnings.push(text); },
  };
  return { host, steered, woken, toMain, formerOwner, warnings, withoutTool };
}

beforeEach(() => {
  setAgentMessagingEnabled(true);
  setAgentMessagingMaxWakes(5);
  resetPeerWakes();
});
afterEach(() => setAgentMessagingEnabled(false));

describe("wrapping (Claude Code's text)", () => {
  it("a peer message mid-turn carries the from= envelope and the reply tail", () => {
    const text = wrapPeerMessage("explore", "found it", { midTurn: true, receiverCanReply: true });
    expect(text.startsWith("Another Claude session sent a message while you were working:\n<agent-message from=\"explore\">\nfound it\n</agent-message>\n\n")).toBe(true);
    expect(text).toContain("that's permission laundering.");
    expect(text.endsWith("(reply via SendMessage to the `from=` address).")).toBe(true);
  });

  it("drops the reply clause when the receiver has no SendMessage", () => {
    const text = wrapPeerMessage("explore", "x", { midTurn: true, receiverCanReply: false });
    expect(text.endsWith("decide whether/how to respond.")).toBe(true);
  });

  it("a resume prompt has the idle header and no tail", () => {
    const text = wrapPeerMessage("explore", "x", { midTurn: false, receiverCanReply: true });
    expect(text.startsWith("Another Claude session sent a message:\n")).toBe(true);
    expect(text.endsWith("that's permission laundering.")).toBe(true);
  });

  it("the main session's message to a running agent", () => {
    expect(wrapCoordinatorMessage("stop")).toBe(
      "The coordinator sent a message while you were working:\nstop\n\nAddress this before completing your current task.");
  });

  it("unwrapForDisplay recovers the sender's own words from every shape", () => {
    for (const opts of [
      { midTurn: true, receiverCanReply: true },
      { midTurn: true, receiverCanReply: false },
      { midTurn: false, receiverCanReply: true },
    ]) {
      expect(unwrapForDisplay(wrapPeerMessage("a", "line 1\nline 2", opts))).toBe("line 1\nline 2");
    }
  });
});

describe("gating", () => {
  it("nobody takes part while the setting is off", () => {
    setAgentMessagingEnabled(false);
    expect(agentTakesPart("general-purpose")).toBe(false);
  });

  it("an agent file opts out with agent_messaging: false", () => {
    expect(agentTakesPart("general-purpose")).toBe(true);
    expect(agentTakesPart("loner")).toBe(false);
  });

  it("a target that opted out refuses the message", async () => {
    const { host, steered } = fakeHost([rec({ id: "a1", handle: "loner", type: "loner" })]);
    expect(await sendMessage(host, undefined, "loner", "hi")).toBe('Agent "loner" does not accept messages.');
    expect(steered).toEqual([]);
  });
});

describe("resolution", () => {
  const records = () => [
    rec({ id: "id-explore", handle: "explore" }),
    rec({ id: "id-plan", handle: "plan", alias: "auth-audit" }),
  ];

  it("by id, handle, alias and case-insensitive name", async () => {
    for (const to of ["id-plan", "plan", "auth-audit", "AUTH-AUDIT"]) {
      const { host, steered } = fakeHost(records());
      await sendMessage(host, undefined, to, "go");
      expect(steered.map(s => s.id)).toEqual(["id-plan"]);
    }
  });

  it("an unknown name suggests close ones", async () => {
    const { host } = fakeHost(records());
    const text = await sendMessage(host, undefined, "expl", "go");
    expect(text).toContain("No agent named 'expl' is reachable. Did you mean: explore?");
  });

  it("an evicted agent points at the Agent tool's resume", async () => {
    const { host } = fakeHost([], [{ handle: "explore", id: "old-id", type: "Explore", description: "d", sessionFile: "/f", completedAt: 1 }]);
    expect(await sendMessage(host, undefined, "explore", "go")).toContain("agent ID old-id");
  });

  it("rejects empty messages, '@' names and self-sends", async () => {
    const { host } = fakeHost(records());
    expect(await sendMessage(host, undefined, "explore", "  ")).toBe("message must not be empty");
    expect(await sendMessage(host, undefined, "@explore", "hi")).toContain("bare agent name");
    expect(await sendMessage(host, "id-explore", "explore", "hi")).toContain("That is you");
  });
});

describe("running target", () => {
  it("from main: the coordinator wrapper, delivered as a steer", async () => {
    const { host, steered } = fakeHost([rec({ id: "a1", handle: "explore" })]);
    const text = await sendMessage(host, undefined, "explore", "check tests");
    expect(steered).toEqual([{ id: "a1", message: wrapCoordinatorMessage("check tests") }]);
    expect(text).toContain("Message queued for delivery to explore at its next tool round.");
  });

  it("from a peer: the agent-message envelope signed with the sender's name", async () => {
    const { host, steered } = fakeHost([
      rec({ id: "s1", handle: "plan", alias: "auth-audit" }),
      rec({ id: "a1", handle: "explore" }),
    ]);
    await sendMessage(host, "s1", "explore", "look at x");
    expect(steered[0].message).toBe(wrapPeerMessage("auth-audit", "look at x", { midTurn: true, receiverCanReply: true }));
  });

  it("a running workflow agent is not steered, from main or from a peer", async () => {
    const { host, steered } = fakeHost([rec({ id: "s1", handle: "plan" }), rec({ id: "a1", handle: "explore", workflowId: "w" })]);
    expect(await sendMessage(host, undefined, "explore", "hi")).toContain("belongs to a workflow run");
    expect(await sendMessage(host, "s1", "explore", "hi")).toContain("belongs to a workflow run");
    expect(steered).toEqual([]);
  });

  it("a finished target still settling is steered, never resumed", async () => {
    const { host, steered, woken } = fakeHost([rec({ id: "a1", handle: "explore", status: "completed", settling: true })]);
    expect(await sendMessage(host, undefined, "explore", "hi")).toContain("Message queued for delivery to explore");
    expect(steered).toHaveLength(1);
    expect(woken).toEqual([]);
  });

  it("a queued target is steered too, never resumed", async () => {
    const { host, steered, woken } = fakeHost([rec({ id: "a1", handle: "explore", status: "queued" })]);
    await sendMessage(host, undefined, "explore", "hi");
    expect(steered).toHaveLength(1);
    expect(woken).toEqual([]);
  });
});

describe("finished target", () => {
  it("from main: resumed with the raw message, which is not also queued", async () => {
    const { host, steered, woken } = fakeHost([rec({ id: "a1", handle: "explore", status: "completed" })]);
    expect(await sendMessage(host, undefined, "explore", "one more thing")).toBe("Resuming agent explore");
    expect(woken).toEqual([{ id: "a1", prompt: "one more thing" }]);
    expect(steered).toEqual([]);
  });

  it("from a peer: resumed with the idle envelope, and its completion now goes to the sender", async () => {
    const target = rec({ id: "a1", handle: "explore", status: "completed" });
    const { host, woken, formerOwner } = fakeHost([rec({ id: "s1", handle: "plan" }), target]);
    await sendMessage(host, "s1", "explore", "redo it");
    expect(woken[0].prompt).toBe(wrapPeerMessage("plan", "redo it", { midTurn: false, receiverCanReply: true }));
    expect(target.handbackRecipient).toBe("s1");
    expect(formerOwner).toEqual([{ ownerId: undefined, text: expect.stringContaining('Agent "explore" was resumed by another agent and now reports to it') }]);
  });

  it("ownership moves before the run starts, and moves back if no run starts", async () => {
    const target = rec({ id: "a1", handle: "explore", status: "completed" });
    const { host } = fakeHost([rec({ id: "s1", handle: "plan" }), target]);
    let ownerAtWake: string | undefined;
    host.wake = vi.fn(async (r: AgentRecord) => { ownerAtWake = r.handbackRecipient; throw new Error("no"); });
    await sendMessage(host, "s1", "explore", "redo it");
    expect(ownerAtWake).toBe("s1");
    expect(target.handbackRecipient).toBeUndefined();
  });

  it("an owned child whose result its owner has not read keeps its owner", async () => {
    const child = rec({ id: "c1", status: "completed", parentAgentId: "owner" });
    const { host, woken, formerOwner } = fakeHost([rec({ id: "owner" }), rec({ id: "s1", handle: "plan" }), child]);
    // Says where the completion goes, instead of promising it back to the sender.
    expect(await sendMessage(host, "s1", "c1", "hi")).toBe("Resuming agent c1; it reports to owner, not to you.");
    expect(woken).toHaveLength(1);
    expect(child.handbackRecipient).toBeUndefined();
    expect(formerOwner).toEqual([]);
  });

  it("never moves ownership into a cycle", async () => {
    // s1 reports to a1; a1 waking s1's way back would make a1 its own ancestor.
    const target = rec({ id: "a1", handle: "explore", status: "completed" });
    const sender = rec({ id: "s1", handle: "plan", handbackRecipient: "a1" });
    const { host } = fakeHost([sender, target]);
    expect(await sendMessage(host, "s1", "explore", "hi")).toBe("Resuming agent explore; it reports to the main conversation, not to you.");
    expect(target.handbackRecipient).toBeUndefined();
  });

  it("from main: a finished nested child is refused, since its completion would reach only its owner", async () => {
    const child = rec({ id: "c1", status: "completed", parentAgentId: "o1" });
    const { host, woken } = fakeHost([rec({ id: "o1", handle: "planner" }), child]);
    expect(await sendMessage(host, undefined, "c1", "hi")).toBe(
      'Agent "c1" belongs to "planner"; its completion would reach only that agent. Message "planner" instead.');
    expect(woken).toEqual([]);
  });

  it("from main: a nested child whose owner has finished is woken, since main now gets its completion", async () => {
    const child = rec({ id: "c1", status: "completed", parentAgentId: "o1" });
    const { host, woken } = fakeHost([rec({ id: "o1", handle: "planner", status: "completed" }), child]);
    expect(await sendMessage(host, undefined, "c1", "hi")).toBe("Resuming agent c1");
    expect(woken).toHaveLength(1);
  });

  it("a send from main leaves the agent with the agent that woke it, as in Claude Code", async () => {
    const target = rec({ id: "a1", handle: "explore", status: "completed", handbackRecipient: "s1" });
    const { host } = fakeHost([rec({ id: "s1" }), target]);
    await sendMessage(host, undefined, "explore", "hi");
    expect(target.handbackRecipient).toBe("s1");
  });

  it("an agent the user stopped is not resumed", async () => {
    const { host, woken } = fakeHost([rec({ id: "a1", handle: "explore", status: "stopped" })]);
    expect(await sendMessage(host, undefined, "explore", "hi")).toContain("was stopped by the user and was not resumed");
    expect(woken).toEqual([]);
  });

  it("failed runs, workflow agents and sessionless agents are not resumed", async () => {
    const cases: [Partial<AgentRecord>, string][] = [
      [{ status: "error" }, "is stopped (error) and could not be resumed"],
      [{ status: "completed", workflowId: "w" }, "belongs to a workflow run"],
      [{ status: "completed", session: undefined }, "its session is gone"],
    ];
    for (const [over, expected] of cases) {
      const { host, woken } = fakeHost([rec({ id: "a1", handle: "explore", ...over })]);
      expect(await sendMessage(host, undefined, "explore", "hi")).toContain(expected);
      expect(woken).toEqual([]);
    }
  });

  it("a resume already in flight queues the message instead", async () => {
    const { host, steered } = fakeHost([rec({ id: "a1", handle: "explore", status: "completed" })]);
    host.wake = vi.fn(async (r: AgentRecord) => { r.status = "running"; return undefined; });
    const text = await sendMessage(host, undefined, "explore", "hi");
    expect(text).toContain("explore is already waking; message queued for its next tool round");
    expect(steered).toEqual([{ id: "a1", message: wrapCoordinatorMessage("hi") }]);
  });

  it("a resume in flight that cannot take the message says so", async () => {
    const { host, steered } = fakeHost([rec({ id: "a1", handle: "explore", status: "completed" })]);
    host.wake = vi.fn(async () => undefined);
    const text = await sendMessage(host, undefined, "explore", "hi");
    expect(text).not.toContain("message queued");
    expect(text).toContain("could not be resumed");
    expect(steered).toEqual([]);
  });

  it("a resume in flight of an agent without SendMessage gets no reply clause", async () => {
    const { host, steered, withoutTool } = fakeHost([
      rec({ id: "s1", handle: "sender" }),
      rec({ id: "a1", handle: "explore", status: "completed" }),
    ]);
    withoutTool.add("a1");
    host.wake = vi.fn(async (r: AgentRecord) => { r.status = "running"; return undefined; });
    await sendMessage(host, "s1", "explore", "hi");
    expect(steered).toEqual([{ id: "a1", message: wrapPeerMessage("sender", "hi", { midTurn: true, receiverCanReply: false }) }]);
  });
});

describe("peer wake budget", () => {
  it("refuses the wake past the budget, until a user input resets it", async () => {
    setAgentMessagingMaxWakes(2);
    const records = [rec({ id: "s1", handle: "plan" }), ...[1, 2, 3].map(n => rec({ id: `t${n}`, handle: `t${n}`, status: "completed" }))];
    const { host, woken } = fakeHost(records);
    await sendMessage(host, "s1", "t1", "hi");
    await sendMessage(host, "s1", "t2", "hi");
    expect(await sendMessage(host, "s1", "t3", "hi")).toContain("Paused until the user's next message");
    expect(woken.map(w => w.id)).toEqual(["t1", "t2"]);

    resetPeerWakes();
    await sendMessage(host, "s1", "t3", "hi");
    expect(woken.map(w => w.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("parallel sends cannot overrun the budget", async () => {
    setAgentMessagingMaxWakes(1);
    const records = [rec({ id: "s1", handle: "plan" }), ...[1, 2, 3].map(n => rec({ id: `t${n}`, handle: `t${n}`, status: "completed" }))];
    const { host } = fakeHost(records);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const woken: string[] = [];
    host.wake = vi.fn(async (r: AgentRecord) => { await gate; woken.push(r.id); r.status = "running"; return r; });
    const sends = ["t1", "t2", "t3"].map(t => sendMessage(host, "s1", t, "hi"));
    release();
    const results = await Promise.all(sends);
    expect(woken).toEqual(["t1"]);
    expect(results.filter(r => r.startsWith("Paused until the user's next message"))).toHaveLength(2);
  });

  it("a wake that does not happen gives its budget back", async () => {
    setAgentMessagingMaxWakes(1);
    const { host, woken } = fakeHost([
      rec({ id: "s1", handle: "plan" }),
      rec({ id: "t1", handle: "t1", status: "completed" }),
      rec({ id: "t2", handle: "t2", status: "completed" }),
    ]);
    const realWake = host.wake;
    host.wake = vi.fn(async () => { throw new Error("no"); });
    expect(await sendMessage(host, "s1", "t1", "hi")).toContain("could not be resumed: no");
    host.wake = realWake;
    expect(await sendMessage(host, "s1", "t2", "hi")).toContain("Resuming agent t2");
    expect(woken.map(w => w.id)).toEqual(["t2"]);
  });

  it("sends from main and sends to running agents never count", async () => {
    setAgentMessagingMaxWakes(1);
    const { host, woken, steered } = fakeHost([
      rec({ id: "s1", handle: "plan" }),
      rec({ id: "r1", handle: "runner" }),
      rec({ id: "t1", handle: "done", status: "completed" }),
      rec({ id: "t2", handle: "done-2", status: "completed" }),
    ]);
    await sendMessage(host, "s1", "runner", "hi");
    await sendMessage(host, undefined, "done", "hi");
    // The one peer wake the budget allows is still there.
    await sendMessage(host, "s1", "done-2", "hi");
    expect(steered).toHaveLength(1);
    expect(woken.map(w => w.id)).toEqual(["t1", "t2"]);
  });
});

describe('to: "main"', () => {
  it("a subagent's message is queued for the main session", async () => {
    const { host, toMain } = fakeHost([rec({ id: "s1", handle: "plan" })]);
    expect(await sendMessage(host, "s1", "main", "done with A")).toBe("Message queued for the main conversation's next turn.");
    expect(toMain).toEqual([{ from: "s1", body: "done with A", wrapped: wrapPeerMessage("plan", "done with A", { midTurn: true, receiverCanReply: true }) }]);
  });

  it("the main session without the SendMessage tool gets no reply clause", async () => {
    const { host, toMain, withoutTool } = fakeHost([rec({ id: "s1", handle: "plan" })]);
    withoutTool.add("main");
    await sendMessage(host, "s1", "main", "done with A");
    expect(toMain[0].wrapped).toBe(wrapPeerMessage("plan", "done with A", { midTurn: true, receiverCanReply: false }));
  });

  it("refuses while agent messaging is off, though the sender kept its tool", async () => {
    const { host, toMain } = fakeHost([rec({ id: "s1", handle: "plan" })]);
    setAgentMessagingEnabled(false);
    expect(await sendMessage(host, "s1", "main", "hi")).toContain("Agent messaging is off");
    expect(toMain).toEqual([]);
  });

  it("the main session cannot address itself", async () => {
    const { host, toMain } = fakeHost([]);
    expect(await sendMessage(host, undefined, "main", "hi")).toContain('"main" addresses you');
    expect(toMain).toEqual([]);
  });

  it("a stopped agent cannot send", async () => {
    const { host, toMain } = fakeHost([rec({ id: "s1", status: "stopped" })]);
    expect(await sendMessage(host, "s1", "main", "hi")).toContain("cannot send messages");
    expect(toMain).toEqual([]);
  });
});

describe("stranded wakes", () => {
  const peer = wrapPeerMessage("plan", "hi", { midTurn: true, receiverCanReply: true });
  const handback = "<task-notification>\n<task-id>t1</task-id>\n</task-notification>";
  const takeover = 'Agent "t1" was resumed by another agent and now reports to it; its completion will not be delivered here.';

  it("a takeover note that strands is a peer wake, charged to the budget", () => {
    setAgentMessagingMaxWakes(1);
    const { host } = fakeHost([]);
    const target = rec({ id: "a1", status: "completed" });
    expect(admitStrandedWake(host, target, [takeover])).toBe(true);
    expect(admitStrandedWake(host, target, [takeover])).toBe(false);
  });

  it("a handback that strands wakes without spending the budget: its result is already marked read", () => {
    setAgentMessagingMaxWakes(0);
    const { host } = fakeHost([]);
    expect(admitStrandedWake(host, rec({ id: "a1", status: "completed" }), [handback])).toBe(true);
  });

  it("a handback dropped with a refused wake goes to the main session", () => {
    setAgentMessagingMaxWakes(0);
    const { host, formerOwner } = fakeHost([]);
    expect(admitStrandedWake(host, rec({ id: "a1", handle: "plan", status: "completed" }), [peer, handback])).toBe(false);
    expect(formerOwner).toHaveLength(1);
    expect(formerOwner[0].ownerId).toBeUndefined();
    expect(formerOwner[0].text).toContain(handback);
  });

  it("a handback stranded in an agent that cannot be woken goes to the main session", () => {
    const { host, formerOwner } = fakeHost([]);
    strandedDropped(host, rec({ id: "a1", handle: "plan", status: "stopped" }), [peer, handback]);
    expect(formerOwner).toEqual([{ ownerId: undefined, text: expect.stringContaining(handback) }]);
    strandedDropped(host, rec({ id: "a2", status: "error" }), [peer]);
    expect(formerOwner).toHaveLength(1);
  });

  it("a steer from the main session wakes without spending the budget", () => {
    setAgentMessagingMaxWakes(0);
    const { host } = fakeHost([]);
    expect(admitStrandedWake(host, rec({ id: "a1", status: "completed" }), ["focus on tests"])).toBe(true);
  });

  it("a peer wake that did not happen gives its budget back, and warns the user if nothing was delivered", () => {
    setAgentMessagingMaxWakes(1);
    const { host, warnings } = fakeHost([]);
    const target = rec({ id: "a1", handle: "explore", status: "completed" });
    expect(admitStrandedWake(host, target, [peer])).toBe(true);
    strandedWakeFailed(host, target, [peer], true);
    expect(warnings).toEqual([]);
    expect(admitStrandedWake(host, target, [peer])).toBe(true);
    strandedWakeFailed(host, target, [peer], false);
    expect(warnings).toEqual(["Failed to deliver queued message to agent explore: it could not be resumed."]);
    expect(admitStrandedWake(host, target, [peer])).toBe(true);
  });
});

describe("reportsToMain", () => {
  it("only a nested agent woken by a message after its owner finished", () => {
    const owner = rec({ id: "o1", status: "completed" });
    const child = rec({ id: "c1", status: "completed", parentAgentId: "o1" });
    const getRecord = (id: string) => (id === "o1" ? owner : undefined);
    expect(reportsToMain(getRecord, child)).toBe(false);
    child.wokenByMessage = true;
    expect(reportsToMain(getRecord, child)).toBe(true);
  });
});

describe("handBack", () => {
  it("a woken nested agent reports to its running parent; one never woken does not", () => {
    const { host, steered } = fakeHost([rec({ id: "p1" })]);
    const quiet = rec({ id: "c1", status: "completed", parentAgentId: "p1" });
    handBack(host, quiet, () => "done");
    expect(steered).toEqual([]);

    const woken = rec({ id: "c2", status: "completed", parentAgentId: "p1", wokenByMessage: true });
    handBack(host, woken, () => "done");
    expect(steered).toEqual([{ id: "p1", message: "done" }]);
    expect(woken.resultConsumed).toBe(true);
  });

  it("never hands a completion to an owner still settling: it has finished, so the main session gets it", () => {
    const { host, steered } = fakeHost([rec({ id: "p1", status: "completed", settling: true })]);
    const child = rec({ id: "c1", status: "completed", parentAgentId: "p1", wokenByMessage: true });
    handBack(host, child, () => "done");
    expect(steered).toEqual([]);
    expect(child.resultConsumed).toBeUndefined();
  });
});
