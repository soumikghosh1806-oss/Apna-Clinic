// A random temporary password the owner can use, made in the browser with the secure random generator.
// Characters that look alike (0 O 1 l I) are left out so it can be read out or typed from a note.

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';

function pick(alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  const bytes = new Uint8Array(1);
  do crypto.getRandomValues(bytes);
  while (bytes[0] >= limit);
  return alphabet[bytes[0] % alphabet.length];
}

/** 12 characters, always with letters and digits, in the pattern Abcd-Efgh-23 so it is easy to say aloud. */
export function suggestPassword(): string {
  const chunk = (alphabet: string, length: number) => Array.from({ length }, () => pick(alphabet)).join('');
  return `${chunk(LETTERS, 4)}-${chunk(LETTERS, 4)}-${chunk(DIGITS, 2)}`;
}
