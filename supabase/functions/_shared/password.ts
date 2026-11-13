// Password rules shared by the browser form and the Edge Functions, so both say the same thing.
// No imports and no platform APIs: it runs in Deno, Node and the browser.

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd123', 'qwerty123', 'qwertyuiop', 'abc1234567',
  '1234567890', '0123456789', '12345678910', 'iloveyou123', 'welcome123', 'admin12345', 'letmein123', 'clinic12345',
  'apnaclinic1', 'cliniq12345',
]);

/** Returns the first problem with a password, or null when it is acceptable. */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  const pw = password ?? '';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (new TextEncoder().encode(pw).length > 72) return 'Use at most 72 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw)) return 'This password is too easy to guess. Choose a less common one.';
  const local = (context.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'Do not use the email address inside the password.';
  return null;
}
