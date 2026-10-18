/** Display only. Never use this value for IO, authorization or comparison. */
export function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  return path;
}

export function shortWorkspacePath(path: string): string {
  const visible = displayPath(path);
  return visible.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") || visible;
}
