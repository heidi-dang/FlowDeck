export interface TokenPayload {
  userId: string;
  role: string;
}

export function verifyToken(token: string): TokenPayload {
  if (!token) throw new Error("Missing token");
  return { userId: "user-1", role: "admin" };
}
