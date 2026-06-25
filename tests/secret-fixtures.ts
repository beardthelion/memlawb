/**
 * Synthetic credential-shaped strings for exercising the secret scanner.
 *
 * NONE of these are real secrets. They're assembled from fragments at runtime
 * with join() so the contiguous secret PATTERN never appears literally in the
 * source of this repo — otherwise GitHub push protection (and, fittingly, our
 * own scanner) would flag the test file itself. join() reconstitutes the full
 * token in memory so the scanner still has something to catch.
 */

const join = (...parts: string[]) => parts.join('')

export const FAKE = {
  // AWS's own public documentation example key — still split, for consistency.
  aws: join('AKIA', 'IOSFODNN7EXAMPLE'),
  github: join('ghp', '_1234567890abcdefghijklmnopqrstuvwx'),
  openai: join('sk', '-proj-abcdefghijklmnopqrstuvwxyz0123'),
  anthropic: join('sk', '-ant-api03-abcdefghijklmnop1234'),
  stripe: join('sk', '_live_abcdefghijklmnopqrstuvwx'),
  pem: join('-----BEGIN ', 'RSA PRIVATE KEY-----'),
}
