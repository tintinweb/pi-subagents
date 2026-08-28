/**
 * viewer.bench.ts — `ConversationViewer.render()` against transcripts of
 * growing size.
 *
 * The highest-value benchmark in the repo: this is the only frame-rate path
 * whose cost is unbounded in the data it renders. `buildContentLines()` renders
 * messages through a per-message block cache, so a warm frame only re-renders
 * messages whose text changed (the streaming tail); everything else is a cache
 * hit. A regression that breaks `contentCache` makes the largest transcript
 * orders of magnitude slower. The viewer subscribes to the session, so a
 * running agent redraws it on every token (coalesced by pi at ~62 Hz), and
 * `handleInput` calls the same build on every scroll key to count lines.
 *
 * Both markdown modes are measured. `assistant` is the default and sends
 * assistant text through pi's Markdown parser; `off` is the raw wrap path. The
 * pair is the cost of #259, and the cap it introduced (RESULT_MAX_CHARS) is what
 * keeps a single large tool result from dominating the whole frame.
 *
 * Cold vs warm is the other axis worth knowing: the Markdown cache is a WeakMap
 * keyed by the message object, so the first frame parses and later frames reuse.
 * A regression that breaks cache identity would leave "warm" looking like
 * "cold" here while every other test stays green.
 */
import { bench, describe } from "vitest";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import { makeSession, mountViewer } from "../helpers/perf-fixtures.js";

const SIZES = [50, 500, 5000];

describe("ConversationViewer.render — markdown: assistant (default)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeSession(n));
    viewer.render(120); // prime: first frame parses, the measured ones reuse
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — markdown: off (raw wrap)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => "off");
    viewer.render(120);
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — cold cache (first frame)", () => {
  // What a viewer costs the moment it is opened on an agent that already has
  // history: every sample renders a viewer that has never rendered, so the
  // Markdown cache starts empty and every message is parsed from scratch.
  //
  // Building those viewers is NOT part of the measurement — `makeSession(500)`
  // allocates 500 message objects and their text, which timed inline would be
  // charged to the render. They are built up front, into a pool sized to the
  // exact number of samples, and each sample takes the next one.
  //
  // A pool rather than tinybench's `beforeEach`, because vitest never gives
  // tinybench a chance to run it: `runBenchmarkSuite` constructs
  // `new Task(bench, name, fn)` with three arguments and drops the fourth
  // options object entirely, so per-task hooks are silently ignored. Bench-level
  // options (`time`, `iterations`) do survive — they go through `new Bench(...)`.
  // A hook-based version of this ran zero samples and reported "NaNx faster".
  const WARMUP = 2;
  const SAMPLES = { 50: 40, 500: 12 } as Record<number, number>;

  for (const n of [50, 500]) {
    const iterations = SAMPLES[n];
    const pool = Array.from({ length: iterations + WARMUP }, () =>
      mountViewer(ConversationViewer, makeSession(n)),
    );
    let next = 0;
    bench(
      `${n} messages`,
      () => {
        // Modulo only guards a miscount; a wrapped entry would be warm, not cold.
        pool[next++ % pool.length].render(120);
      },
      { time: 0, iterations, warmupTime: 0, warmupIterations: WARMUP },
    );
  }
});
