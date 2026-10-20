// Small pure helpers shared by the proposal-related Edge Functions.

// JSON with object keys sorted at every level, so the same data always serializes the same way
// no matter what order a database or client happened to return the keys in.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// SHA-256 of the stable serialization, as hex. Recorded on a proposal when it is drafted and
// compared when it is applied, to catch a planogram that was edited in between.
export async function fingerprint(value) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic id for the planogram a proposal creates, so a retried apply can never produce two.
export const appliedPlanogramId = (proposalId) => `pog_ai_${proposalId}`;
