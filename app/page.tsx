import { VoiceAgentScreen } from "@/components/voice/VoiceAgent";
import { authRequired } from "@/lib/auth";

/**
 * Reads whether authentication is switched on here, on the server, and passes it down as a plain
 * prop. The client component therefore needs no session state of its own to decide whether to show
 * a sign-out control.
 */
export default function Page() {
  return <VoiceAgentScreen authRequired={authRequired()} />;
}
