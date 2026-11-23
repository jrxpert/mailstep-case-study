import type { DeliveryActivity, TrackingState } from "../../domain/types.ts";

/** What a carrier-specific parser extracts from its own status section. */
export interface CarrierReading {
  pageTrackingNumber: string | null;
  state: TrackingState;
  activity: DeliveryActivity | null;
  reason: string;
  source: string | null;
  statusText: string | null;
  eventText: string | null;
  eventTime: { text: string; local: string } | null;
  /** Earliest dated event, for pages with an event history. */
  earliestEventTime?: { text: string; local: string };
  warnings: string[];
}

export function unknown(reason: string, partial: Partial<CarrierReading> = {}): CarrierReading {
  return {
    pageTrackingNumber: null, activity: null, source: null, statusText: null, eventText: null,
    eventTime: null, warnings: [], ...partial, state: "UNKNOWN", reason,
  };
}
