import { URL } from 'url';

// Never resolve names here: a hostname that merely happens to resolve locally
// today is not a stable transport-security boundary. These are the literal
// loopback forms users can safely use for local gateways and SSH tunnels.
export function isLoopbackHostname(hostname: string): boolean {
  const host = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' ||
    host === '::ffff:127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Return a user-safe explanation when credentials would traverse plaintext HTTP.
 * Local loopback endpoints are intentionally allowed for local servers and SSH
 * tunnels; every other credentialed endpoint must be HTTPS.
 */
export function credentialedEndpointSecurityError(url: URL, hasCredential: boolean): string | null {
  const credentialed = hasCredential || !!url.username || !!url.password;
  if (!credentialed || url.protocol === 'https:' || isLoopbackHostname(url.hostname)) return null;
  return 'Refusing to send credentials to a non-loopback HTTP endpoint. Use HTTPS.';
}
