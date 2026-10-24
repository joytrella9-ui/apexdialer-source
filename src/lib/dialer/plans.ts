export const PLANS = {
  trial: { label: "Trial", maxAgents: 3, maxContacts: 500, maxCampaigns: 3, maxSmsPerDay: 40 },
  starter: { label: "Starter", maxAgents: 15, maxContacts: 10000, maxCampaigns: 25, maxSmsPerDay: 400 },
  growth: { label: "Growth", maxAgents: 75, maxContacts: 100000, maxCampaigns: 200, maxSmsPerDay: 4000 },
} as const;

export type PlanId = keyof typeof PLANS;

export function isPlanId(value: string): value is PlanId {
  return value === "trial" || value === "starter" || value === "growth";
}

export function planLimits(plan: string) {
  return isPlanId(plan) ? PLANS[plan] : PLANS.trial;
}

/** Trial and paid-active workspaces can create records. Past due and canceled are read-only for new work. */
export function billingAllowsMutation(status: string): boolean {
  return status === "trial" || status === "active";
}
