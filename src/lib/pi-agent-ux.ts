/** Preserve intentional leading/inner whitespace while removing terminal newlines. */
export function normalizedPiDraft(value: string): string {
  return value.replace(/\r/g, '').replace(/\n+$/, '')
}

/** Never erase edits made while a semantic prompt acknowledgement was pending. */
export function draftAfterAcknowledgement(current: string, submitted: string): string {
  return current === submitted ? '' : current
}

/** Prompt-library insertion appends to the host draft, never to native TUI stdin. */
export function appendPiDraft(current: string, inserted: string): string {
  return `${current}${inserted}`
}

