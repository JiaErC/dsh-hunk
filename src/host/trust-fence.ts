/**
 * Browser-trust fence for the dsh-hunk route.
 *
 * Every DSH webserver route owns its own fence — the webserver itself only
 * dispatches — so a plugin route that reads host state has to apply the same
 * rule the `/api` gateway does: the `Host` header must name this machine
 * (loopback, or an authority the deployment explicitly trusts), and a browser
 * that attaches cross-site markers is refused. This is a DNS-rebinding /
 * cross-site defense, not authentication.
 *
 * Behaviorally identical to `@deepseek-ai/dsh-client-connection`'s
 * `api-request-trust` (and to dsh-better-sidebar's copy of it), restated here
 * because neither package exports the helper.
 */
import type { IncomingHttpHeaders } from 'node:http'

/** The request facts the fence reads (structural subset of IncomingMessage). */
export interface FenceRequest {
  headers: IncomingHttpHeaders
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach the dsh-hunk route.
 * @param request - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
export function isTrustedRequest(request: FenceRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin fence: when a browser attaches an Origin it must name this hostname
  // (the Host fence already bound the authority, so the port must not
  // re-decide trust). An absent Origin is fine; the literal "null"
  // (sandboxed iframes, file: pages) is an opaque origin and is refused.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
