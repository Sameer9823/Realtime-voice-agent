import { describe, expect, it } from "vitest";
import { getCurrentTime, getProductInformation, VOICE_TOOLS } from "@/lib/voice/tools";
import { createVoiceAgent, turnDetection } from "@/lib/voice/agent";
import { VOICE_INSTRUCTIONS } from "@/lib/voice/config";

/**
 * Tool and agent-configuration tests.
 *
 * These assert the tools are registered through the SDK's own tool system (zod parameters, JSON
 * Schema conversion) rather than through anything bespoke, which is what lets the realtime session
 * execute them mid-conversation.
 */

describe("voice tools", () => {
  it("registers the demo tools with the agent", () => {
    expect(VOICE_TOOLS.map((t) => t.name)).toEqual(["get_current_time", "get_product_information"]);
  });

  it("get_current_time returns a usable time", () => {
    const result = getCurrentTime.execute({}) as { iso: string; human: string; timeZone: string };
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.human.length).toBeGreaterThan(0);
    expect(result.timeZone.length).toBeGreaterThan(0);
  });

  it("get_current_time accepts an IANA time zone", () => {
    const result = getCurrentTime.execute({ timeZone: "America/New_York" }) as { timeZone: string };
    expect(result.timeZone).toBe("America/New_York");
  });

  it("get_current_time degrades gracefully on an unknown time zone", () => {
    const result = getCurrentTime.execute({ timeZone: "Not/AZone" }) as { human: string };
    expect(result.human.length).toBeGreaterThan(0);
  });

  it("get_product_information returns pricing for a known product", () => {
    const result = getProductInformation.execute({ product: "atlas" }) as Record<string, unknown>;
    expect(result.name).toBe("Atlas Analytics");
    expect(Array.isArray(result.pricing)).toBe(true);
    expect(result.apiPricing).toBeDefined();
  });

  it("get_product_information can return only one section", () => {
    const pricing = getProductInformation.execute({ product: "beacon", detail: "pricing" }) as Record<string, unknown>;
    expect(pricing.pricing).toBeDefined();
    expect(pricing.summary).toBeUndefined();
  });

  it("get_product_information reports unknown products instead of throwing", () => {
    const result = getProductInformation.execute({ product: "nope" }) as Record<string, unknown>;
    expect(result.error).toMatch(/no product named/i);
    expect(Array.isArray(result.available)).toBe(true);
  });

  it("declares parameters the SDK can validate and serialise", () => {
    // The realtime session converts these zod schemas to JSON Schema when it registers the tools, so
    // they must be real zod schemas rather than plain objects.
    for (const tool of VOICE_TOOLS) {
      const parsed = tool.parameters.safeParse({});
      expect(parsed.success).toBe(true);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
    }
    // A real schema rejects the wrong shape rather than silently passing it to execute().
    expect(getCurrentTime.parameters.safeParse({ timeZone: 42 }).success).toBe(false);
    expect(getProductInformation.parameters.safeParse({ detail: "not_a_section" }).success).toBe(false);
  });

  it("tool names are valid for OpenAI's function-call interface", () => {
    for (const tool of VOICE_TOOLS) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
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
    expect(VOICE_INSTRUCTIONS).toMatch(/as an ai language model/i);
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