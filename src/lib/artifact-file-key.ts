/** Preserve filesystem semantics; a lexical key must never resolve parent segments. */
export function artifactFilePath(path: string, cwd?: string): string {
  if (/^(?:[/\\]|[A-Za-z]:|~\/)/.test(path) || !cwd) return path;
  return `${cwd.replace(/[/\\]$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** Lexical identity only. This never resolves symlinks, reads files or grants access. */
export function artifactFileKey(path: string, cwd?: string): string {
  let value = path.replace(/\\/g, "/");
  const absolute = (input: string) => /^(?:\/|[A-Za-z]:\/|~\/)/.test(input);
  // Drive-relative paths depend on a drive's own working directory. Do not guess it.
  if (/^[A-Za-z]:[^/]/.test(value)) return value;
  if (!absolute(value) && cwd && absolute(cwd.replace(/\\/g, "/"))) {
    value = `${cwd.replace(/\\/g, "/").replace(/\/$/, "")}/${value}`;
  }
  const prefix = value.startsWith("//") ? "//"
    : value.match(/^[A-Za-z]:\//)?.[0].toUpperCase()
      ?? (value.startsWith("/") ? "/" : value.startsWith("~/") ? "~/" : "");
  const segments: string[] = [];
  for (const segment of value.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    // link/../file may name a different file from file. Only native identity
    // resolution can establish that two paths containing .. are equivalent.
    segments.push(segment);
  }
  return prefix + segments.join("/") || ".";
}
