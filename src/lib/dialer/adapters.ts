export type AdapterSecrets = {
  webhookUrl: string;
  webhookSecret: string;
  hubspotToken: string;
  salesforceUrl: string;
  salesforceToken: string;
  whatsappFrom: string;
};

export type AdapterStatus = {
  webhook: boolean;
  hubspot: boolean;
  salesforce: boolean;
  whatsapp: boolean;
};

export type CallPush = {
  callId: string;
  disposition: string;
  notes: string;
  from: string;
  to: string;
  durationSeconds: number | null;
  contactName: string;
  at: string;
};

const EMPTY: AdapterSecrets = {
  webhookUrl: "",
  webhookSecret: "",
  hubspotToken: "",
  salesforceUrl: "",
  salesforceToken: "",
  whatsappFrom: "",
};

export function parseAdapters(raw: string): AdapterSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== "object") return { ...EMPTY };
  const row = parsed as Record<string, unknown>;
  return {
    webhookUrl: text(row.webhookUrl, 300),
    webhookSecret: text(row.webhookSecret, 200),
    hubspotToken: text(row.hubspotToken, 400),
    salesforceUrl: text(row.salesforceUrl, 200),
    salesforceToken: text(row.salesforceToken, 2000),
    whatsappFrom: text(row.whatsappFrom, 24),
  };
}

export function adapterStatus(secrets: AdapterSecrets): AdapterStatus {
  return {
    webhook: Boolean(safeOutboundUrl(secrets.webhookUrl)),
    hubspot: secrets.hubspotToken.trim().length >= 8,
    salesforce: Boolean(salesforceBase(secrets.salesforceUrl)) && secrets.salesforceToken.trim().length >= 8,
    whatsapp: /^\+[1-9]\d{7,14}$/.test(secrets.whatsappFrom.trim()),
  };
}

/** Public https only. Blocks localhost and private networks so a saved URL cannot probe this server. */
export function safeOutboundUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return null;
  }
  return url.toString();
}

export function salesforceBase(value: string): string | null {
  const url = safeOutboundUrl(value);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase();
  if (!host.endsWith(".salesforce.com") && !host.endsWith(".force.com")) return null;
  return url.replace(/\/$/, "");
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
