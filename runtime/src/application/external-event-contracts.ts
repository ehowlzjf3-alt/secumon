import { z } from 'zod';
import type { ExternalNotification, ExternalSubscription } from '../domain/external-events.js';
const id = z.string().min(1).max(160), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ExternalSubscriptionSchema: z.ZodType<ExternalSubscription> = z.strictObject({ id, provider: id, resourceId: id,
  goalRevision: count.positive(), generation: count, cursor: count, status: z.enum(['active', 'closed']), checkpointId: id });
export const ExternalNotificationSchema: z.ZodType<ExternalNotification> = z.strictObject({ id, subscriptionId: id, provider: id, resourceId: id, referenceId: id,
  goalRevision: count.positive(), observedPlanRevision: count, receivedAt: count });
export const ExternalSubscriptionsSchema = z.array(ExternalSubscriptionSchema).max(16).refine(values => new Set(values.map(value => value.id)).size === values.length);
export const ExternalNotificationsSchema = z.array(ExternalNotificationSchema).max(512).refine(values => new Set(values.map(value => value.id)).size === values.length);
