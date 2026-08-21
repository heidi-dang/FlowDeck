import { verifyToken } from "./jwt";
import { add } from "../utils/math";

export function authenticateUser(token: string) {
  const payload = verifyToken(token);
  const score = add(10, 20);
  return { ...payload, score };
}
