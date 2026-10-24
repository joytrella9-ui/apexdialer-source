export type Role = "owner" | "admin" | "supervisor" | "agent";

export type Action =
  | "dial"
  | "manage_contacts"
  | "import_contacts"
  | "export_contacts"
  | "manage_campaigns"
  | "view_reports"
  | "view_all_calls"
  | "correct_disposition"
  | "view_audit"
  | "manage_team"
  | "manage_settings"
  | "manage_dnc"
  | "test_telephony";

const RANK: Record<Role, number> = { agent: 1, supervisor: 2, admin: 3, owner: 4 };

export function isRole(value: string): value is Role {
  return value === "owner" || value === "admin" || value === "supervisor" || value === "agent";
}

export function roleRank(role: Role): number {
  return RANK[role];
}

/** Owners may grant any role. Everyone else may only grant a strictly lower rank. */
export function canGrantRole(actor: Role, role: Role): boolean {
  if (actor === "owner") return true;
  return roleRank(role) < roleRank(actor);
}

/** Owners may edit any member. Everyone else may only edit a strictly lower rank. */
export function canEditMember(actor: Role, memberRole: Role): boolean {
  if (actor === "owner") return true;
  return roleRank(memberRole) < roleRank(actor);
}

export function can(role: Role, action: Action): boolean {
  const rank = RANK[role];
  switch (action) {
    case "dial":
      return true;
    case "manage_contacts":
    case "import_contacts":
    case "export_contacts":
    case "manage_campaigns":
    case "view_reports":
    case "view_all_calls":
    case "correct_disposition":
    case "view_audit":
      return rank >= RANK.supervisor;
    case "manage_team":
    case "manage_settings":
    case "manage_dnc":
    case "test_telephony":
      return rank >= RANK.admin;
    default:
      return false;
  }
}
