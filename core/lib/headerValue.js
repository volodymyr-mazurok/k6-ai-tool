// The value of a static auth header (project.yaml `auth.type: static_header`). Pure ES module with no k6 or Node imports,
// so the same file runs inside k6 and under the Node test runner.

/** The characters `${random:N}` draws from: lower-case letters and digits, safe in any header. */
export const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Replace every `${random:N}` in `template` with N characters drawn from RANDOM_ALPHABET. Any other `${...}` left in the
 * template is an error: the runner replaces `${env:NAME}` before k6 starts, so one that reaches k6 is a bug.
 * @param {string} template
 * @param {() => number} [random] a source of numbers in [0, 1); Math.random by default
 * @returns {string}
 */
export function expandRandom(template, random = Math.random) {
  return String(template).replace(/\$\{([^}]*)\}/g, (_all, inner) => {
    const match = /^random:(\d+)$/.exec(inner);
    // Never echo the template: the runner may already have put a secret into it.
    if (!match) throw new Error('static header: a placeholder other than ${random:N} reached k6 (the runner replaces ${env:...} first)');
    let out = '';
    for (let i = 0; i < Number(match[1]); i++) out += RANDOM_ALPHABET[Math.floor(random() * RANDOM_ALPHABET.length)];
    return out;
  });
}
