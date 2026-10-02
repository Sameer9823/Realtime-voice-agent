import { z } from "zod";
// Imported from the `voice` entry, not the package root: the root entry pulls in Node-only modules
// (sandbox, session stores) and cannot be bundled for the browser.
import { defineTool } from "samai-sdk/voice";

/**
 * Demo tools for the voice agent.
 *
 * These are ordinary SamAI SDK `ToolDefinition`s with zod parameters. The SDK converts the schema to
 * JSON Schema when it registers the tool on the realtime session, and executes `execute()` itself
 * when the model calls it — so tool calling rides the existing SDK tool loop rather than a
 * side-channel, and the result is fed straight back into the live conversation.
 */

/**
 * Returns the current local time. Exists to demonstrate a tool call inside a live audio turn:
 * the agent says "let me check", calls this, and answers from the result without the audio
 * session being interrupted.
 */
export const getCurrentTime = defineTool({
  name: "get_current_time",
  description:
    "Get the current date and time on the server, including the day of the week. Use this whenever the user asks what time it is, what day it is, or what the date is.",
  parameters: z.object({
    timeZone: z
      .string()
      .optional()
      .describe('IANA time zone such as "UTC" or "America/New_York". Defaults to the server time zone.'),
  }),
  execute: (args) => {
    const { timeZone } = args;
    const now = new Date();
    let formatted: string;
    let resolvedZone: string;
    try {
      formatted = new Intl.DateTimeFormat("en-US", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      resolvedZone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
    } catch {
      // An unknown IANA zone shouldn't fail the turn; fall back to server-local time.
      formatted = `${now.toDateString()}, ${now.toLocaleTimeString("en-US")}`;
      resolvedZone = "server local time";
    }
    return { iso: now.toISOString(), timeZone: resolvedZone, human: formatted };
  },
});

interface ProductInfo {
  name: string;
  tagline: string;
  summary: string;
  pricing: { plan: string; monthly: string; includes: string[] }[];
  apiPricing: { unit: string; price: string };
}

/**
 * Small in-memory catalogue used to show a multi-argument tool call resolving a pronoun across turns
 * ("what about its pricing?" → the product named in the previous turn).
 */
const PRODUCTS: Record<string, ProductInfo> = {
  atlas: {
    name: "Atlas Analytics",
    tagline: "Product analytics that answers questions in plain English",
    summary:
      "Atlas tracks product events and lets people ask questions about usage in plain language, without writing queries.",
    pricing: [
      { plan: "Starter", monthly: "Free", includes: ["Up to 1 million events per month", "3 seats"] },
      { plan: "Team", monthly: "$120 per month", includes: ["10 million events per month", "Unlimited seats"] },
      { plan: "Business", monthly: "From $600 per month", includes: ["Custom event volume", "SSO and audit log"] },
    ],
    apiPricing: {
      unit: "1,000 events ingested",
      price: "$0.30",
    },
  },
  beacon: {
    name: "Beacon Notifications",
    tagline: "Transactional messaging that actually arrives",
    summary:
      "Beacon delivers email, push, and SMS through one API with delivery receipts and automatic retries.",
    pricing: [
      { plan: "Starter", monthly: "Free", includes: ["10,000 messages per month"] },
      { plan: "Growth", monthly: "$90 per month", includes: ["250,000 messages per month", "Priority delivery"] },
    ],
    apiPricing: {
      unit: "1,000 messages sent",
      price: "$0.18",
    },
  },
};

/**
 * Looks up a product. If `product` is omitted the agent can infer it from the conversation, which is
 * how "what about its pricing?" resolves without the user repeating the product name.
 */
export const getProductInformation = defineTool({
  name: "get_product_information",
  description:
    "Look up details for a product, including its pricing plans and its API pricing. Use this when the user asks about a product, its plans, its cost, or its API rates. If the product was already mentioned earlier in the conversation, call this without repeating the name.",
  parameters: z.object({
    product: z
      .string()
      .optional()
      .describe('Product identifier, e.g. "atlas" or "beacon". Omit to use the product already being discussed.'),
    detail: z
      .enum(["overview", "pricing", "api_pricing", "all"])
      .optional()
      .describe('Which part of the product to return. Defaults to "all".'),
  }),
  execute: (args) => {
    const key = (args.product ?? "atlas").toLowerCase().trim();
    const detail = args.detail ?? "all";
    const product = PRODUCTS[key];
    if (!product) {
      return {
        error: `No product named "${key}".`,
        available: Object.keys(PRODUCTS),
      };
    }
    const result: Record<string, unknown> = { name: product.name, tagline: product.tagline };
    if (detail === "overview" || detail === "all") result.summary = product.summary;
    if (detail === "pricing" || detail === "all") result.pricing = product.pricing;
    if (detail === "api_pricing" || detail === "all") result.apiPricing = product.apiPricing;
    return result;
  },
});

/** Every tool available to the voice agent during a conversation. */
export const VOICE_TOOLS = [getCurrentTime, getProductInformation];