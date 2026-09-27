/** Use the ordinary spelling at the Theia/URL boundary; keep the native grant unchanged. */
export function idePath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const disk = /^\/\/\?\/([A-Za-z]:\/.*)$/.exec(slashed);
  if (disk) return disk[1];
  const unc = /^\/\/\?\/UNC\/(.+)$/i.exec(slashed);
  if (unc) return `//${unc[1]}`;
  return slashed;
}

/** Compare paths at the Theia boundary, where Windows paths may use either spelling. */
export function relativeToWorkspace(root: string, path: string): string | null {
  const rootPath = idePath(root);
  const normalizedRoot = rootPath === "/" || /^[A-Za-z]:\/$/.test(rootPath)
    ? rootPath : rootPath.replace(/\/+$/, "");
  const candidatePath = idePath(path);
  const normalizedPath = candidatePath === "/" || /^[A-Za-z]:\/$/.test(candidatePath)
    ? candidatePath : candidatePath.replace(/\/+$/, "");
  if (!normalizedRoot || normalizedPath.split("/").includes("..")) return null;
  const windows = /^[A-Za-z]:\//.test(normalizedRoot) || /^\/\/[^/]+\/[^/]+/.test(normalizedRoot);
  const compareRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparePath = windows ? normalizedPath.toLowerCase() : normalizedPath;
  if (comparePath === compareRoot) return "";
  const prefix = compareRoot.endsWith("/") ? compareRoot : `${compareRoot}/`;
  return comparePath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : null;
}
