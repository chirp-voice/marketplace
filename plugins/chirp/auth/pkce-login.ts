import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { exec } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Prod Clerk PUBLIC OAuth client — safe to ship (neither value is a secret;
// the client_id rides in every authorize URL, the base is the public Frontend API origin).
// Override via env (CLERK_OAUTH_BASE / CLERK_OAUTH_CLIENT_ID) for the dev stack.
const DEFAULT_BASE = 'https://clerk.chirp.dev'
const DEFAULT_CLIENT_ID = 'c482BsIXruDDieiw'

/** Resolve the OAuth client config: env overrides win, baked prod defaults otherwise. */
export function oauthConfig(): { base: string; clientId: string; clientSecret?: string } {
  const base = process.env.CLERK_OAUTH_BASE || DEFAULT_BASE
  const clientId = process.env.CLERK_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID
  const clientSecret = process.env.CLERK_OAUTH_CLIENT_SECRET || undefined // public client has none
  if (!/^https?:\/\//.test(base)) {
    throw new Error(`Chirp auth: CLERK_OAUTH_BASE must be an http(s) URL, got "${base}"`)
  }
  if (!clientId) throw new Error('Chirp auth: CLERK_OAUTH_CLIENT_ID resolved empty')
  return { base, clientId, clientSecret }
}
const SCOPE = 'openid profile email offline_access'
const PORT = 53682
const CRED_DIR = join(homedir(), '.chirp')
const CRED_FILE = join(CRED_DIR, 'credentials.json')
const SKEW_MS = 60_000

export type Creds = { accessToken: string; refreshToken: string; expiresAt: number }

const b64url = (b: Buffer) => b.toString('base64url')

export function pkcePair() {
  const verifier = b64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 min conservative fallback when expires_in is missing/invalid

export function parseTokenResponse(json: any, nowMs: number, priorRefresh?: string): Creds {
  const ttl = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? priorRefresh ?? '',
    // Guard against NaN (missing/invalid expires_in): treat as a short 5-min TTL so
    // needsRefresh() fires on the next check rather than silently accepting a bad token.
    expiresAt: nowMs + (Number.isFinite(ttl) ? ttl * 1000 : DEFAULT_TTL_MS),
  }
}

export function needsRefresh(creds: Creds | null, nowMs: number): boolean {
  if (!creds?.accessToken) return true
  // NaN expiresAt (e.g. persisted before the isFinite guard was added) always triggers refresh.
  if (!Number.isFinite(creds.expiresAt)) return true
  return creds.expiresAt - nowMs <= SKEW_MS
}

export function loadCreds(): Creds | null {
  try { return JSON.parse(readFileSync(CRED_FILE, 'utf8')) } catch { return null }
}
export function save(c: Creds) {
  mkdirSync(CRED_DIR, { recursive: true })
  writeFileSync(CRED_FILE, JSON.stringify(c), { mode: 0o600 })
  chmodSync(CRED_FILE, 0o600)
}
export function clearCreds(): void {
  rmSync(CRED_FILE, { force: true }) // force: no throw if missing
}

async function exchange(body: URLSearchParams): Promise<any> {
  const { base, clientSecret } = oauthConfig()
  if (clientSecret) body.set('client_secret', clientSecret)
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  })
  const json = await r.json()
  if (!json.access_token) throw new Error(`token exchange failed: ${JSON.stringify(json)}`)
  return json
}

async function refresh(refreshToken: string): Promise<Creds> {
  const json = await exchange(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: oauthConfig().clientId,
  }))
  return parseTokenResponse(json, Date.now(), refreshToken)
}

export type LoginOpts = { port?: number; timeoutMs?: number; open?: (url: string) => void }
const DEFAULT_TIMEOUT_MS = 180_000 // 3 min — long enough for a real sign-in, short enough to fail loud

export function loginInteractive(opts: LoginOpts = {}): Promise<Creds> {
  const { base, clientId } = oauthConfig()
  const port = opts.port ?? PORT
  const redirect = `http://127.0.0.1:${port}/cb`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const openBrowser = opts.open ?? ((url: string) => { exec(`open "${url}"`) })
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(16))
  const authUrl =
    `${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`
  return new Promise<Creds>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, redirect)
      if (url.searchParams.get('state') !== state) { res.writeHead(400); res.end('stale'); return }
      const err = url.searchParams.get('error')
      if (err) { res.writeHead(200); res.end('error'); clearTimeout(timer); server.close(); reject(new Error(err)); return }
      try {
        const json = await exchange(new URLSearchParams({
          grant_type: 'authorization_code', code: url.searchParams.get('code')!,
          redirect_uri: redirect, client_id: clientId, code_verifier: verifier,
        }))
        res.writeHead(200); res.end('Signed in — return to terminal.')
        clearTimeout(timer); server.close(); resolve(parseTokenResponse(json, Date.now()))
      } catch (e) { res.writeHead(500); res.end('exchange failed'); clearTimeout(timer); server.close(); reject(e as Error) }
    })
    server.on('error', (e) => { clearTimeout(timer); reject(e) })
    server.listen(port, () => {
      console.error(`[chirp-auth] sign in: ${authUrl}`)
      openBrowser(authUrl)
      timer = setTimeout(() => {
        server.close()
        reject(new Error('sign-in timed out — re-run /chirp-auth'))
      }, timeoutMs)
    })
  })
}

// Silent: a currently-valid access token, or null if not signed in. NEVER opens a browser.
export async function getAccessToken(): Promise<string | null> {
  const creds = loadCreds()
  if (creds && !needsRefresh(creds, Date.now())) return creds.accessToken
  if (creds?.refreshToken) {
    try { const next = await refresh(creds.refreshToken); save(next); return next.accessToken } catch (e) {
      console.error('[chirp-channel] token refresh failed —', String(e))
    }
  }
  return null
}

// Best-effort decode of a JWT payload's identity claims. No verification, no network.
export function identityFromToken(token: string): { email?: string; sub?: string } {
  try {
    const seg = token.split('.')[1]
    if (!seg) return {}
    const json = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>
    const out: { email?: string; sub?: string } = {}
    if (typeof json.email === 'string') out.email = json.email
    if (typeof json.sub === 'string') out.sub = json.sub
    return out
  } catch { return {} }
}
