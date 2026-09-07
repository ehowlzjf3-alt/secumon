export interface ExternalSubscription {
  id: string; provider: string; resourceId: string; goalRevision: number; generation: number;
  cursor: number; status: 'active' | 'closed'; checkpointId: string;
}
/** A bounded reference to unreviewed incoming work, never the source document or an instruction with elevated authority. */
export interface ExternalNotification {
  id: string; subscriptionId: string; provider: string; resourceId: string; referenceId: string;
  goalRevision: number; observedPlanRevision: number; receivedAt: number;
}
