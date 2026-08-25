import { getNodeB } from "./node-b";
export function getNodeA() { return { name: "A", b: getNodeB() }; }
