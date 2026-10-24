export function readTranscriptEvent(input: { event: string; data: string; track: string; finalFlag: string }): { speaker: string; text: string; final: boolean } | null {
  if (input.event !== "transcription-content") return null;
  let text = "";
  try {
    const parsed = JSON.parse(input.data) as { transcript?: unknown };
    text = typeof parsed.transcript === "string" ? parsed.transcript.trim() : "";
  } catch {
    text = "";
  }
  if (!text) return null;
  const speaker = /outbound/i.test(input.track) ? "contact" : /inbound/i.test(input.track) ? "agent" : "line";
  return { speaker, text: text.slice(0, 500), final: input.finalFlag === "true" };
}

export function pressOneLine(orgName: string, script: string): string {
  const name = orgName.trim() || "us";
  const first = script.trim().split(/\n+/).find((line) => line.trim() && !/^(\*|[-•]|MUST:|Say:)/i.test(line.trim()))?.trim() ?? "";
  const intro = first ? first.slice(0, 160) : `Hello, this is ${name}.`;
  return `${intro} Press 1 to be connected. Press 2 to stop these calls.`.slice(0, 280);
}

export function agentWhisper(name: string): string {
  const who = name.trim() || "A contact";
  return `${who} pressed 1. You are about to be connected.`.slice(0, 180);
}

export function summarizeTranscript(lines: string[]): { summary: string; points: string[] } {
  const clean = lines.map((line) => line.trim()).filter(Boolean).slice(0, 40);
  if (clean.length === 0) return { summary: "No transcript lines were stored for this call.", points: [] };
  const points = clean.filter((line) => line.includes("?") || line.length > 80).slice(0, 4);
  return { summary: clean.slice(0, 3).join(" ").slice(0, 420), points };
}
