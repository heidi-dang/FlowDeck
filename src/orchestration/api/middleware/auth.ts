import type { IncomingMessage, ServerResponse } from "http";
import { OrchestrationError, ErrorCodes } from "../../types";
import type { IAuthorizationService } from "../../services/ports";

export function authMiddleware(authService?: IAuthorizationService) {
  return async (req: IncomingMessage, _res: ServerResponse): Promise<{ userId?: string; roles?: string[] } | null> => {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
      throw OrchestrationError.fromCode(ErrorCodes.UNAUTHENTICATED, { message: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      throw OrchestrationError.fromCode(ErrorCodes.UNAUTHENTICATED, { message: "Empty token" });
    }

    if (authService) {
      const result = await authService.authorize("api.access", "orchestration", { token });
      if (!result.allowed) {
        throw OrchestrationError.fromCode(ErrorCodes.FORBIDDEN, { message: result.reason ?? "Access denied" });
      }
    }

    return { userId: "system", roles: ["admin"] };
  };
}
