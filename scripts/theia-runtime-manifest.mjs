/** Keep build-time and packaged dependency policies identical. */
export function createTheiaRuntimeManifest(app, source) {
  return {
    ...app,
    name: "@echoagent/theia-runtime",
    private: true,
    engines: { ...app.engines, ...source.engines },
    packageManager: source.packageManager,
    allowScripts: { ...source.allowScripts, ...app.allowScripts },
    workspaces: ["packages/*", "examples/*", "security/*"],
    theiaPluginsDir: "plugins",
    scripts: {},
    devDependencies: {},
    overrides: { ...source.overrides, ...app.overrides },
  };
}
