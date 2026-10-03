import { describe, expect, it } from "vitest";
import { VOICE_TOOLS, getWeather, lookupDocs, webSearch } from "@/lib/voice/tools";
import { createVoiceAgent, turnDetection } from "@/lib/voice/agent";
import { VOICE_INSTRUCTIONS } from "@/lib/voice/config";
import { TOOL_NAMES } from "@/lib/tools/registry";

/**
 * Agent-configuration and tool-registration tests.
 *
 * These assert the tools are registered through the SDK's own tool system (zod parameters, JSON
 * Schema conversion) rather than through anything bespoke, which is what lets the realtime session
 * execute them mid-conversation, and that the browser stubs and the server registry agree.
 */

describe("voice tools", () => {
  it("registers the real tools with the agent", () => {
    expect(VOICE_TOOLS.map((tool) => tool.name)).toEqual(["web_search", "get_weather", "lookup_docs"]);
  });

  it("registers exactly the tools the server can execute", () => {
    // If these drift, the model will confidently call a tool that 404s at runtime.
    expect(VOICE_TOOLS.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("declares parameters the SDK can validate and serialise", () => {
    for (const tool of VOICE_TOOLS) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("rejects wrongly typed arguments before they reach a tool", () => {
    expect(webSearch.parameters.safeParse({ query: 42 }).success).toBe(false);
    expect(getWeather.parameters.safeParse({ location: 42 }).success).toBe(false);
    expect(lookupDocs.parameters.safeParse({ question: "x" }).success).toBe(false);
  });

  it("accepts well-formed arguments", () => {
    expect(webSearch.parameters.safeParse({ query: "weather in Lisbon" }).success).toBe(true);
    expect(getWeather.parameters.safeParse({ location: "Lisbon" }).success).toBe(true);
    expect(lookupDocs.parameters.safeParse({ question: "how do I start the app" }).success).toBe(true);
  });

  it("bounds argument length so one turn cannot send an unbounded payload", () => {
    expect(webSearch.parameters.safeParse({ query: "x".repeat(500) }).success).toBe(false);
    expect(getWeather.parameters.safeParse({ location: "x".repeat(500) }).success).toBe(false);
    expect(lookupDocs.parameters.safeParse({ question: "x".repeat(500) }).success).toBe(false);
  });

  it("tool names are valid for OpenAI's function-call interface", () => {
    for (const tool of VOICE_TOOLS) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("describes each tool for a spoken audience", () => {
    // These strings are read by the model, so they should say when to use the tool, not how it works.
    expect(webSearch.description).toMatch(/current|recent|news/i);
    expect(getWeather.description).toMatch(/weather/i);
    expect(lookupDocs.description).toMatch(/documentation/i);
  });
});

describe("agent definition", () => {
  const agent = createVoiceAgent("gpt-realtime", "marin");

  it("uses the model and voice supplied per connection", () => {
    expect(agent.model).toBe("gpt-realtime");
    expect(agent.voice?.voiceId).toBe("marin");
  });

  it("always allows interruption so barge-in is never gated", () => {
    // A confidence gate would add latency exactly when the user is trying to cut in.
    expect(agent.voice?.interruption).toBe("always-allow");
  });

  it("instructs the model to yield the turn immediately when interrupted", () => {
    const instructions = agent.instructions.toLowerCase();
    expect(instructions).toContain("talk over you at any time");
    expect(instructions).toContain("stop talking immediately");
  });

  it("keeps the spoken-style rules", () => {
    const instructions = agent.instructions.toLowerCase();
    expect(instructions).toContain("short, natural sentences");
    expect(instructions).toContain("keep responses brief");
  });

  it("no longer forbids the assistant from acknowledging it is an AI", () => {
    // Refusing to answer a sincere question is worse than a plain answer, so the hard prohibition
    // is gone. The softer rules about not narrating internals stay.
    expect(VOICE_INSTRUCTIONS).not.toMatch(/as an ai language model/i);
    expect(VOICE_INSTRUCTIONS.toLowerCase()).toContain("don't narrate your reasoning");
  });

  it("tells the model when to use each tool and not to over-use them", () => {
    const instructions = agent.instructions.toLowerCase();
    expect(instructions).toContain("web search");
    expect(instructions).toContain("weather tool");
    expect(instructions).toContain("documentation tool");
    expect(instructions).toContain("only when it would genuinely improve the answer");
  });

  it("instructs the model to wait for permission on side-effecting tools", () => {
    expect(agent.instructions.toLowerCase()).toContain("ask the user plainly whether you should go ahead");
  });

  it("requests semantic turn detection with interruption enabled", () => {
    // Semantic VAD is what lets a natural hesitation mid-sentence survive instead of being cut off
    // by a fixed silence timer.
    expect(turnDetection.type).toBe("semantic_vad");
    expect(turnDetection.interruptResponse).toBe(true);
    expect(turnDetection.createResponse).toBe(true);
  });

  it("carries the tools into the SDK agent config", () => {
    expect(agent.tools).toHaveLength(VOICE_TOOLS.length);
  });
});