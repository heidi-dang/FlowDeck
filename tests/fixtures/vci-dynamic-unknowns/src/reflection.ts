export function getReflectedProp(target: any, prop: string) {
  return Reflect.get(target, prop);
}
