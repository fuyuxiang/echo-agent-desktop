// Read-only compatibility discovery; only the caller's new private Echo TOML
// receives these identities. No foreign configuration values are logged.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function readonlyCompatibilitySourceRevocations() {
  const external = join(homedir(), '.claude'), identities = new Set();
  const identity = (value) => {
    if (value.includes('://') || value.startsWith('git@')) return value.trim().replace(/\/+$/, '').replace(/\.git$/, '');
    const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(value);
    return existsSync(expanded) ? realpathSync(expanded) : expanded;
  };
  for (const [name, nested] of [['settings.json', true], ['settings.local.json', true], ['plugins/known_marketplaces.json', false]]) {
    const path = join(external, name);
    if (!existsSync(path)) continue;
    const file = lstatSync(path);
    if (!file.isFile() && !file.isSymbolicLink()) continue;
    let parsed; try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    const entries = nested ? parsed.extraKnownMarketplaces : parsed;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const entry of Object.values(entries)) {
      const source = typeof entry?.source === 'object' ? entry.source : entry;
      let value;
      if (source?.source === 'git') value = source.url;
      else if (source?.source === 'github' && typeof source.repo === 'string') value = `https://github.com/${source.repo}.git`;
      else if (['local', 'directory'].includes(source?.source)) value = source.path;
      if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) continue;
      if (value.includes('://')) {
        let url; try { url = new URL(value); } catch { throw new Error('Invalid compatibility catalog identity'); }
        assert(!url.password && (url.protocol === 'ssh:' || !url.username) && !url.search && !url.hash,
          'Refusing credential-bearing compatibility catalog identity');
      }
      identities.add(identity(value));
    }
  }
  return [...identities].sort();
}
