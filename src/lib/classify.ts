export type EnquiryKind = "availability" | "inspection" | "maintenance" | "leasing" | "other";

/**
 * Sorts a customer enquiry into a queue.
 *
 * This is a deliberately simple keyword stand-in so the template runs with no API key.
 * In a real tool, replace the body with a model call (Claude, Azure OpenAI and so on) that
 * returns one of the same labels. The evaluation in evals/ then tells you whether a prompt
 * or model change made results better or worse before it reaches production.
 */
export function classifyEnquiry(text: string): EnquiryKind {
  const t = text.toLowerCase();
  if (/(leak|broken|repair|not working|mould|blocked|fix)/.test(t)) return "maintenance";
  if (/(inspect|viewing|open home|look at the property|come and see)/.test(t)) return "inspection";
  if (/(available|still on the market|taken|vacant)/.test(t)) return "availability";
  if (/(bond|lease|rent|application|pets)/.test(t)) return "leasing";
  return "other";
}
