/**
 * Twilio AnsweredBy. Only a finished machine signal or a fax skips the agent.
 * `machine_start` is too early and can be a person, so it still rings the agent.
 * Unknown is treated as a person.
 */
export function isMachineAnswer(answeredBy: string): boolean {
  const value = answeredBy.trim().toLowerCase();
  return value === "machine_end_beep" || value === "machine_end_silence" || value === "machine_end_other" || value === "fax";
}

