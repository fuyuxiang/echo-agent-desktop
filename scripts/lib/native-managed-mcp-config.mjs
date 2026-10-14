// Compare real private configuration without persisting credential values.
// Only the four built-in loopback MCP process ports/Bearer tokens are volatile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export function managedMcpConfigSha256(path) {
  const script = `import sys,tomllib,json,urllib.parse
c=tomllib.loads(sys.stdin.read())
for name in ['echoagent','echoagent-office','echoagent-automation','echoagent-live-info']:
 m=c['mcp_servers'][name];u=urllib.parse.urlsplit(m['url'])
 assert u.scheme=='http' and u.hostname=='127.0.0.1' and u.path=='/mcp' and u.port and not u.username and not u.password and not u.query and not u.fragment
 m['url']='http://127.0.0.1:<runtime-port>/mcp'
 token=m['headers']['Authorization'];assert token.startswith('Bearer ') and len(token)>30
 m['headers']['Authorization']='Bearer <runtime-token>'
print(json.dumps(c,sort_keys=True,ensure_ascii=False))
`;
  const result = spawnSync('python3', ['-c', script], { input: readFileSync(path), encoding: 'utf8' });
  assert.equal(result.status, 0, 'Managed MCP invariant parsing failed');
  return createHash('sha256').update(result.stdout.trim()).digest('hex');
}
