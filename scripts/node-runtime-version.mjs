export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
  const supported = major === 22 && (minor > 23 || minor === 23 && patch >= 4)
    || major === 24 && (minor > 22 || minor === 22 && patch >= 1);
  if (!supported) {
    throw new Error("Echo Code requires Node.js 22.23.4+ (22.x) or 24.22.1+ (24.x). Update Node.js, then rerun this command.");
  }
}

export function assertSupportedNpmVersion(version) {
  const [major, minor, patch] = version.trim().split(".").map(Number);
  if (!(major > 11 || major === 11 && (minor > 21 || minor === 21 && patch >= 1))) {
    throw new Error("Echo Code requires npm 11.21.1+ to install its workspace lock consistently. Update npm, then rerun this command.");
  }
}
