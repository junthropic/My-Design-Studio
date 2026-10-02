export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    ...options,
    headers: {
      ...(!(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      'x-studio-request': '1',
      ...options.headers,
    },
  });
  if (!response.ok) {
    const e = await response.json().catch(() => ({ error: `요청 오류 ${response.status}` }));
    throw new Error(typeof e.error === 'string' ? e.error : e.message || JSON.stringify(e.error));
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export function upload(path: string, file: File, fields: Record<string, string> = {}) {
  const data = new FormData();
  data.append('file', file);
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return api(path, { method: 'POST', body: data });
}
