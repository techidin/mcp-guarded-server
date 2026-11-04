import { z } from "zod";

const RoleSchema = z.enum(["viewer", "editor"]);
const UserSchema = z.object({
  token: z.string().min(16),
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  role: RoleSchema,
});

export type Role = z.infer<typeof RoleSchema>;
export type Caller = Omit<z.infer<typeof UserSchema>, "token">;

// Demo sign-in: each user has a static bearer token in demo/users.json.
// Production puts an OAuth 2.1 / OpenID Connect authorization server in front
// and verifies short-lived access tokens here instead (see README).
export function createAuthenticator(config: unknown) {
  const byToken = new Map<string, Caller>();
  for (const { token, ...caller } of z.array(UserSchema).parse(config)) {
    byToken.set(token, caller);
  }

  return (authorization: string | null): Caller | undefined => {
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    return token === undefined ? undefined : byToken.get(token);
  };
}
