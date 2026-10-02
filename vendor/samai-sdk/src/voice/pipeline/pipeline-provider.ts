import type { VoiceProvider, VoiceSession, VoiceAgentEvent, VoiceConnectOptions } from "../types.js";
import type { STTProvider } from "../stt/types.js";
import type { TTSProvider } from "../tts/types.js";
import type { Provider } from "../../types.js";
import { createClient, GuardrailBlockedError } from "../../client.js";
import { executeToolCalls } from "../../tool-loop.js";
import { createTrace, recordEvent, addUsage, finishTrace, type RunTrace } from "../../trace.js";
import { ConversationEngine } from "../conversation-engine.js";
import { randomUUID } from "../../uuid.js";
import { hasSentenceBoundary } from "./vad.js";

export interface PipelineVoiceOptions { stt: STTProvider; llm: Provider; tts: TTSProvider; }

export function pipelineVoice(options: PipelineVoiceOptions): VoiceProvider {
  return { name: "pipeline:" + options.llm.name, async connect(connectOptions: VoiceConnectOptions): Promise<VoiceSession> {
  const agent = connectOptions.agent; const voiceSession = connectOptions.session; const runId = randomUUID();
  const trace: RunTrace = createTrace(runId, agent.name);
  const handlers = new Map<string, Set<Function>>();
  function emit(event: VoiceAgentEvent) { const s = handlers.get(event.type); if (s) for (const h of [...s]) { try { (h as any)(event); } catch {} } }
  function on(type: string, handler: Function): () => void { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(handler); return () => handlers.get(type)?.delete(handler); }
  const engine = new ConversationEngine({ agent, session: voiceSession, trace, onEvent: emit });
  let sttSession: any = null; let ttsSession: any = null; let llmAbort: AbortController | null = null; let closed = false;
  ttsSession = await options.tts.connect();
  ttsSession.onAudioChunk((chunk: ArrayBuffer) => { engine.handleAgentAudioChunk(chunk); });
  ttsSession.onDone(() => { engine.handleAgentSpeechEnded(); });
  sttSession = await options.stt.connect({
    onResult: async (result: any) => {
      if (closed) return;
      if (!result.isFinal) { if (engine.getState() === "speaking") { const did = engine.handleBargeIn({ confidence: result.confidence, durationMs: 300, transcript: result.transcript }); if (did) { try { llmAbort?.abort(); } catch {} try { ttsSession?.cancel(); } catch {} } } return; }
      if (engine.getState() === "speaking") { const did = engine.handleBargeIn({ confidence: result.confidence, durationMs: 400, transcript: result.transcript }); if (did) { try { llmAbort?.abort(); } catch {} try { ttsSession?.cancel(); } catch {} } }
      const clar: any = engine.handleUserSpeechEnded(result.transcript, result.confidence);
      if (clar && clar.type === "clarification-requested") { engine.handleAgentThinking(); engine.handleAgentSpeechStarted(); try { ttsSession.synthesize(clar.question, { voiceId: agent.voice?.voiceId }); } catch {} await voiceSession?.appendMessages([{ role: "user", content: result.transcript }]); return; }
      await voiceSession?.appendMessages([{ role: "user", content: result.transcript }]);
      await runLLM(result.transcript);
    },
    onError: (err: Error) => { if (!closed) engine.handleRunFailed(err); }
  });
  async function runLLM(transcript: string) {
    if (closed) return; engine.handleAgentThinking(); llmAbort = new AbortController();
    const client = createClient({ provider: options.llm });
    const shaping = engine.getShapingSuffix(transcript);
    const system = agent.instructions + (shaping ? " " + shaping : "");
    let hist: import("../../types.js").Message[] = [];
    if (voiceSession) { try { hist = await voiceSession.getMessages(); } catch {} }
    let llmMessages = [...hist];
    const lastContent = llmMessages[llmMessages.length-1]?.content;
    if (lastContent !== transcript) llmMessages.push({ role: "user", content: transcript });
    // input guardrails — same fail-closed shape as run.ts
    for (const g of (agent as any).guardrails?.input ?? []) {
      const r = await g({ messages: llmMessages });
      if (!r.allowed) {
        const reason = r.reason ?? "unspecified";
        recordEvent(trace, { type: "guardrail-triggered", stage: "input", agentName: agent.name, reason } as any);
        engine.handleRunFailed(new GuardrailBlockedError(reason, "input"));
        return;
      }
      if (r.modifiedMessages) llmMessages = r.modifiedMessages;
    }
    let fullText = ""; let buffer = ""; let usage: import("../../types.js").Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; let startedSpeaking = false;
    let toolCalls = [];
    try {
      for await (const chunk of client.stream({ model: agent.model, system, messages: llmMessages, tools: agent.tools, maxToolRoundtrips: 1, signal: llmAbort.signal })) {
        if (closed || llmAbort.signal.aborted) break;
        if (chunk.type === "text-delta") { fullText += chunk.textDelta; buffer += chunk.textDelta;
          if (!startedSpeaking && hasSentenceBoundary(buffer) && buffer.trim().length > 10) { engine.handleAgentSpeechStarted(); startedSpeaking = true; try { ttsSession.synthesize(buffer, { voiceId: agent.voice?.voiceId }); } catch {} buffer = ""; }
          else if (startedSpeaking && hasSentenceBoundary(buffer)) { try { ttsSession.synthesize(buffer, { voiceId: agent.voice?.voiceId }); } catch {} buffer = ""; }
        } else if (chunk.type === "tool-call") { toolCalls.push(chunk.toolCall); engine.handleToolStarted(chunk.toolCall.toolName, chunk.toolCall.args); }
        else if (chunk.type === "tool-result") { engine.handleToolCompleted(chunk.toolResult.toolName, chunk.toolResult.result); }
        else if (chunk.type === "finish") { usage = chunk.usage; }
      }
      if (toolCalls.length > 0 && !llmAbort.signal.aborted) {
        const results = await executeToolCalls(toolCalls, agent.tools ?? [], { agentName: agent.name });
        for (const r of results) engine.handleToolCompleted(r.toolName, r.result);
        try { await voiceSession?.appendMessages([{ role: "tool", content: results }]); } catch {}
      }
      if (buffer.trim() && !llmAbort.signal.aborted) { if (!startedSpeaking) { engine.handleAgentSpeechStarted(); startedSpeaking = true; } try { ttsSession.synthesize(buffer, { voiceId: agent.voice?.voiceId }); } catch {} }
      // output guardrails — same shape as run.ts
      if (fullText && !llmAbort.signal.aborted) {
        let _text = fullText;
        let _object: unknown = fullText;
        for (const g of (agent as any).guardrails?.output ?? []) {
          const dummy: import("../../types.js").GenerateResult = { model: agent.model, text: _text, toolCalls, finishReason: "stop", usage, messages: llmMessages, raw: null, object: _object };
          const out = await g({ result: dummy });
          if (!out.allowed) {
            const reason = out.reason ?? "unspecified";
            recordEvent(trace, { type: "guardrail-triggered", stage: "output", agentName: agent.name, reason } as any);
            engine.handleRunFailed(new GuardrailBlockedError(reason, "output"));
            return;
          }
          if (out.modifiedResult) { if (out.modifiedResult.text !== undefined) _text = out.modifiedResult.text; if (out.modifiedResult.object !== undefined) _object = out.modifiedResult.object; }
        }
        fullText = _text;
        // flush any remaining buffer text that may differ after guardrail rewrite
      }
      if (fullText && !llmAbort.signal.aborted) { await voiceSession?.appendMessages([{ role: "assistant", content: fullText }]); recordEvent(trace, { type: "model-call", agentName: agent.name, model: agent.model, turn: 1 } as any); recordEvent(trace, { type: "model-call-completed", agentName: agent.name, usage } as any); addUsage(trace, usage); engine.handleRunCompleted(usage); }
    } catch (err: any) { if (err?.name === "AbortError" || llmAbort.signal.aborted) return; const e = err instanceof Error ? err : new Error(String(err)); engine.handleRunFailed(e); }
  }
  const session: any = {
    sendAudio(chunk: ArrayBuffer) { if (!closed && sttSession) try { sttSession.sendAudio(chunk); } catch {} },
    interrupt() { engine.handleExplicitInterrupt(); try { llmAbort?.abort(); } catch {} try { ttsSession?.cancel(); } catch {} emit({ type: "interruption", reason: "explicit" } as any); },
    async close() { if (closed) return; closed = true; try { llmAbort?.abort(); } catch {} try { ttsSession?.cancel(); } catch {} try { await sttSession?.close(); } catch {} try { await ttsSession?.close(); } catch {} finishTrace(trace); },
    on(type: string, handler: Function) { return on(type, handler); }
  };
  session._trace = trace; session._engine = engine; return session as VoiceSession;
  }};
}
