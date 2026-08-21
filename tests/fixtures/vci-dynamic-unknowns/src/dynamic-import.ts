export async function loadModule(name: string) {
  return await import(`./modules/${name}`);
}
