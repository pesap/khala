export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // The compiled package may still contain a genuine JavaScript import.
    }
  }
  return nextResolve(specifier, context);
}
