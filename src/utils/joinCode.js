import { randomInt } from 'crypto';

// Thirty characters, with every glyph that survives being read aloud across a
// cricket ground and typed back correctly. Removed: 0/O, 1/I/L, and U — the
// first two are the classic misreads, and U is dropped so no code can spell
// something the scorer then has to apologise for.
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 6;

/**
 * A share code for a match: six characters, ~729 million possibilities.
 *
 * `randomInt` rather than `Math.random`: it is uniform over the alphabet and
 * costs nothing here, whereas the modulo-of-a-float approach quietly biases
 * toward the front of the alphabet. This is not a secret, but a code that is
 * predictable in its *shape* is easier to enumerate than one that is not, and
 * there is no reason to accept that for free.
 *
 * Uniqueness is NOT this function's job — the unique index on Match.joinCode is,
 * and createMatch retries on E11000. Six characters make a collision vanishingly
 * rare; the index is what makes the retry correct rather than hopeful.
 */
export const generateJoinCode = () => {
    let code = '';
    for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
        code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
    }
    return code;
};

/**
 * True if `value` could be a join code at all — right length, right alphabet,
 * case-insensitively. Used to reject obvious rubbish before a database round
 * trip, never as authorisation.
 */
export const looksLikeJoinCode = (value) => {
    if (typeof value !== 'string') return false;
    const upper = value.trim().toUpperCase();
    if (upper.length !== JOIN_CODE_LENGTH) return false;
    return [...upper].every((char) => JOIN_CODE_ALPHABET.includes(char));
};
