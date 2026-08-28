import { authenticateUser } from "../src/auth/service";

if (typeof authenticateUser !== "function") {
  throw new Error("authenticateUser should be a function");
}
