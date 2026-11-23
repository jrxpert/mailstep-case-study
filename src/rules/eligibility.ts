// Business eligibility for definitions A and B (FR-1…FR-6). Pure: order + rules + reference time.
// Complaints, returns, reporter and tracking are deliberately NOT considered here.

import { hasEffect, mayDenote, reason } from "../domain/reason.ts";
import type { BusinessEligibility, DefinitionId, Order, Reason, Rules } from "../domain/types.ts";
import { calendarDaysInPrague, stateEntryTimestamp } from "../time/pragueDays.ts";

const canonical = (s: string): string => s.normalize("NFC").trim();

export function evaluateEligibility(order: Order, rules: Rules, now: string): BusinessEligibility {
  const entry = (Object.entries(rules.definitions) as [DefinitionId, Rules["definitions"][DefinitionId]][]).find(
    ([, def]) => def.status === order.status,
  );
  if (!entry) {
    return {
      status: "ineligible",
      definition: null,
      complaintReason: null,
      stateEntry: null,
      daysInStatus: null,
      minDaysInStatus: null,
      reasons: [reason("NOT_A_CANDIDATE_STATUS", `status "${order.status}" is not covered by any definition`)],
    };
  }
  const [definition, def] = entry;
  const reasons: Reason[] = [];

  // Exclusions — only this definition's list. Exact match after NFC+trim; a case-only difference is
  // treated as ambiguous (review) rather than silently "not excluded".
  const method = canonical(order.shippingMethod);
  const exact = def.excludedShippingMethods.find((m) => canonical(m) === method);
  const loose = def.excludedShippingMethods.find((m) => mayDenote(canonical(m), method));
  if (exact !== undefined) {
    reasons.push(reason("EXCLUDED_SHIPPING_METHOD", `"${order.shippingMethod}" is excluded for definition ${definition}`));
  } else if (loose !== undefined) {
    reasons.push(reason("AMBIGUOUS_SHIPPING_METHOD", `"${order.shippingMethod}" differs only in case, spacing, punctuation or look-alike characters from excluded "${loose}"`));
  }

  // Calendar days in Prague since entry into the current status (never updatedAt).
  const stateEntry = stateEntryTimestamp(order);
  let daysInStatus: number | null = null;
  const days = calendarDaysInPrague(stateEntry?.value, now);
  if (days.ok) {
    daysInStatus = days.days;
    if (days.days < def.minDaysInStatus) {
      reasons.push(
        reason("THRESHOLD_NOT_REACHED", `${days.days} of ${def.minDaysInStatus} calendar days (${stateEntry?.field} → Prague ${days.entryPragueDate})`),
      );
    }
  } else {
    const code = days.error === "INVALID_REFERENCE_TIMESTAMP" ? "INVALID_TIMESTAMP" : days.error;
    reasons.push(reason(code, `${stateEntry?.field ?? "entry timestamp"}: ${days.detail}`));
  }

  const status = hasEffect(reasons, "skip") ? "ineligible" : hasEffect(reasons, "review") ? "undetermined" : "eligible";
  if (status === "eligible") {
    reasons.push(
      reason("BUSINESS_ELIGIBLE", `definition ${definition}: ${daysInStatus} ≥ ${def.minDaysInStatus} calendar days in ${def.status}, method not excluded`),
    );
  }
  return {
    status,
    definition,
    complaintReason: def.complaintReason,
    stateEntry,
    daysInStatus,
    minDaysInStatus: def.minDaysInStatus,
    reasons,
  };
}
