// Example only (not run by `npm test` — it needs a browser/React DOM environment).
// Shows the `samai-sdk/react` subpath: a thin hook wrapper around runAgentStream().
import { createClient, anthropic, defineAgent } from "../src/index.js";
import { useAgent } from "../src/react.js";

const client = createClient({ provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

const supportAgent = defineAgent({
  name: "support_agent",
  instructions: "Answer developer support questions about SamAI SDK concisely.",
  model: "claude-sonnet-4-6",
});

export function SupportChat() {
  const { run, isRunning, text, events, result, error } = useAgent(client, supportAgent);

  return (
    <div>
      <button
        onClick={() => run("How do I add a handoff between two agents?")}
        disabled={isRunning}
      >
        {isRunning ? "Thinking…" : "Ask SamAI"}
      </button>

      {/* Streams in live as text-delta events arrive */}
      <p>{text}</p>

      {/* Live activity feed: tool calls, handoffs, retries, guardrail trips, etc. */}
      <ul>
        {events
          .filter((e) => e.type !== "text-delta")
          .map((e, i) => (
            <li key={i}>{e.type}</li>
          ))}
      </ul>

      {error && <p style={{ color: "red" }}>Error: {error.message}</p>}
      {result && <p>Finished — final agent: {result.finalAgent}</p>}
    </div>
  );
}
