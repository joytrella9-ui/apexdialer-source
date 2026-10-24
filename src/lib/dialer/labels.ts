export const DISPOSITION_LABEL: Record<string, string> = {
  answered: "Answered",
  interested: "Interested",
  not_interested: "Not interested",
  callback: "Callback",
  voicemail: "Voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Failed",
  wrong_number: "Wrong number",
  do_not_call: "Do not call",
  skipped: "Skipped",
};

export const STATE_LABEL: Record<string, string> = {
  manual_open: "Dialing on device",
  requested: "Requested",
  ringing: "Ringing",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  supervisor: "Supervisor",
  agent: "Agent",
};

export function presenceLabel(status: string): string {
  switch (status) {
    case "available":
      return "Available";
    case "on_call":
      return "On a call";
    case "wrap_up":
      return "Wrap-up";
    case "break":
      return "Break";
    default:
      return "Offline";
  }
}
