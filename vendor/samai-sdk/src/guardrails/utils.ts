import type { Message } from "../types.js";

/** Extracts the plain-text content of a message, ignoring images/tool parts. */
export function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
}

/** Extracts plain text from the most recent message with the given role (default: user). */
export function getLastText(messages: Message[], role: Message["role"] = "user"): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return getMessageText(messages[i]);
  }
  return "";
}
