import { UserProfile } from "../generated/user_pb";
export function renderUser(u: UserProfile) { return u.email; }
