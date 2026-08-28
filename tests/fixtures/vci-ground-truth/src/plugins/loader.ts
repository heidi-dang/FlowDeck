export async function loadPlugin(name: string) {
  return await import(`./${name}`);
}
