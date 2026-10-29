export const permissions = [
    "files:read",
    "files:write",
    "realtime:connect",
] as const;
export type Permission = (typeof permissions)[number];

export const rolePermissions = {
    owner: permissions,
    admin: permissions,
    member: ["files:read", "realtime:connect"],
} as const satisfies Record<string, readonly Permission[]>;

export type OrganizationRole = keyof typeof rolePermissions;
