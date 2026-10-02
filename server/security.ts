import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { ApiError, type StudioStore } from './store';
export interface SecretCipher {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export class SecretVault {
  private memory = new Map<string, string>();
  constructor(
    private store: StudioStore,
    private cipher?: SecretCipher,
  ) {}
  get persistence() {
    return this.cipher ? 'os-encrypted' : 'session-only';
  }
  set(id: string, value: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || value.length > 8192)
      throw new ApiError(400, '잘못된 키 이름 또는 길이입니다.');
    if (this.cipher) {
      this.store.setSetting('secret:' + id, {
        encrypted: this.cipher.encrypt(value).toString('base64'),
      });
    } else this.memory.set(id, value);
  }
  get(id: string) {
    if (this.memory.has(id)) return this.memory.get(id);
    if (!this.cipher) return undefined;
    const record = this.store.setting<{ encrypted?: string }>('secret:' + id, {});
    if (!record.encrypted) return undefined;
    try {
      return this.cipher.decrypt(Buffer.from(record.encrypted, 'base64'));
    } catch {
      return undefined;
    }
  }
  remove(id: string) {
    this.memory.delete(id);
    this.store.setSetting('secret:' + id, {});
  }
  status() {
    return Object.fromEntries(
      ['openai', 'anthropic', 'gemini', 'higgsfield'].map((id) => [id, Boolean(this.get(id))]),
    );
  }
}
export function inside(root: string, relative: string) {
  const resolved = path.resolve(root, relative);
  const diff = path.relative(path.resolve(root), resolved);
  if (diff.startsWith('..') || path.isAbsolute(diff))
    throw new ApiError(400, '허용되지 않는 파일 경로입니다.');
  return resolved;
}
export const localGuard: RequestHandler = (req, res, next) => {
  const remote = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))
    return res.status(403).json({ error: '로컬 연결만 허용됩니다.' });
  const host = (req.headers.host ?? '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '['].includes(host))
    return res.status(403).json({ error: '허용되지 않는 호스트입니다.' });
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol !== 'http:') throw 0;
    } catch {
      return res.status(403).json({ error: '허용되지 않는 Origin입니다.' });
    }
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-studio-request') !== '1')
    return res.status(403).json({ error: '요청 검증 헤더가 없습니다.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
};
function privateAddress(address: string) {
  const s = address.toLowerCase();
  if (s.includes(':'))
    return (
      s === '::1' ||
      s === '::' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      s.startsWith('fe8') ||
      s.startsWith('fe9') ||
      s.startsWith('fea') ||
      s.startsWith('feb') ||
      s.startsWith('ff') ||
      s.startsWith('::ffff:') ||
      s.startsWith('2001:db8:') ||
      s.startsWith('100:')
    );
  const a = s.split('.').map(Number);
  return (
    a[0] === 0 ||
    a[0] === 10 ||
    a[0] === 127 ||
    a[0] >= 224 ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && (a[1] === 168 || (a[1] === 0 && [0, 2].includes(a[2])))) ||
    (a[0] === 198 && ([18, 19].includes(a[1]) || (a[1] === 51 && a[2] === 100))) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113) ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127)
  );
}
async function resolvePublic(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError(400, '올바른 HTTPS URL을 입력하세요.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new ApiError(400, '인증정보 없는 HTTPS 표준 포트 주소만 허용됩니다.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true });
  } catch {
    throw new ApiError(400, '서버 주소를 확인할 수 없습니다.');
  }
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new ApiError(400, '내부 네트워크와 로컬 주소는 가져올 수 없습니다.');
  return { url, hostname, address: addresses[0] };
}
export async function publicUrl(input: string) {
  return (await resolvePublic(input)).url;
}
export async function fetchLimited(
  input: string,
  init: RequestInit = {},
  limit = 20 * 1024 * 1024,
) {
  // Pin the validated address to this connection: a second DNS lookup must not bypass the private-network check.
  const { url, hostname, address } = await resolvePublic(input);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = url.host;
  return new Promise<{ buffer: Buffer; mime: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: address.address,
        family: address.family,
        servername: isIP(hostname) ? undefined : hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        signal: init.signal ?? AbortSignal.timeout(30000),
      },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(
            new ApiError(
              502,
              `외부 서비스 오류 (${response.statusCode ?? 0}). 리디렉션은 허용하지 않습니다.`,
            ),
          );
          return;
        }
        if (Number(response.headers['content-length']) > limit) {
          response.destroy();
          reject(new ApiError(413, '응답 파일이 너무 큽니다.'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            response.destroy(new ApiError(413, '응답 파일이 너무 큽니다.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            buffer: Buffer.concat(chunks),
            mime: String(response.headers['content-type'] ?? 'application/octet-stream'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
