import { getNodeA } from "./node-a";
export function getNodeB() { return { name: "B", a: () => getNodeA() }; }
