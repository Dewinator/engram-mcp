/**
 * System-prompt injection helpers for the small-model middleware.
 *
 * Pure functions — no I/O, no globals. Take a chat-message array (Ollama
 * /api/chat format) and a context block, return a new array with the
 * mycelium block prepended as a `system` message.
 *
 * Strategy choices (deliberate):
 *
 * - **Prepend, don't merge.** The mycelium block lives in its own system
 *   message at the head of the array, marked with a sentinel so the
 *   middleware can detect repeat injections (idempotency) and so an
 *   operator inspecting the request body can identify the block at a
 *   glance.
 * - **Idempotent.** If the messages array already starts with a mycelium
 *   block, the new block replaces the old one. No accidental
 *   double-injection if the same array is forwarded through more than
 *   once.
 * - **No-op on null/empty.** If the prime-fetcher returned no context,
 *   the messages array is returned unchanged (cloned to keep the same
 *   reference-immutable contract).
 */

export interface ChatMessage {
  role:    string;
  content: string;
}

/** Sentinel marker on the injected system message — used for idempotency. */
export const MYCELIUM_BLOCK_MARKER = "<!-- mycelium:context -->";

/**
 * Wrap a context-block string in a marked system message body.
 */
export function buildContextBlock(contextText: string): string {
  return `${MYCELIUM_BLOCK_MARKER}\n${contextText}\n${MYCELIUM_BLOCK_MARKER}`;
}

/**
 * Inject (or replace) the mycelium block at the head of the messages array.
 *
 * Returns a NEW array; does not mutate the input. If `contextText` is
 * null/empty, the input array is returned cloned (still no mutation).
 */
export function injectContext(messages: ChatMessage[], contextText: string | null | undefined): ChatMessage[] {
  const cloned = messages.map((m) => ({ ...m }));
  if (!contextText || !contextText.trim()) return cloned;

  const block = buildContextBlock(contextText.trim());

  // Idempotent: if the first message is already a mycelium-marked system
  // message, replace its body instead of stacking another one.
  if (cloned.length > 0 && cloned[0].role === "system" && cloned[0].content.includes(MYCELIUM_BLOCK_MARKER)) {
    cloned[0] = { role: "system", content: block };
    return cloned;
  }

  return [{ role: "system", content: block }, ...cloned];
}

/**
 * Pull the most recent user-message text out of a messages array. Used as
 * the `task_description` input to the prime-fetcher.
 *
 * Returns undefined when there is no user-role message — e.g. agent-only
 * back-and-forth. The fetcher then surfaces the static block only (no
 * recall), which is the right behaviour for opening turns.
 */
export function lastUserText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content?.trim()) {
      return messages[i].content.trim();
    }
  }
  return undefined;
}
