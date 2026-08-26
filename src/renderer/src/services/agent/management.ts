export function agentManagement<T = unknown>(request: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  file?: { name: string; mimeType: string; data: Uint8Array }
}): Promise<T> {
  return window.api.echoAgent.managementRequest<T>(request)
}
