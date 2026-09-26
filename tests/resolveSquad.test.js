import { resolveSquad, SQUAD_ROLES } from '../src/utils/resolveSquad.js';

const expectCode = (fn, code) => {
    try {
        fn();
    } catch (err) {
        expect(err.statusCode).toBe(400);
        expect(err.message).toBe(code);
        return;
    }
    throw new Error(`expected ${code} to be thrown`);
};

describe('resolveSquad', () => {
    it('exposes the accepted roles', () => {
        expect(SQUAD_ROLES).toEqual(['batsman', 'bowler', 'allrounder']);
    });

    it('trims names and resolves designations to the trimmed squad names', () => {
        const result = resolveSquad({
            players: [
                { name: '  Rohit Sharma ', role: 'batsman' },
                { playerId: 'p2', name: 'Bumrah', role: 'bowler' },
            ],
            captain: ' rohit sharma',
            viceCaptain: 'BUMRAH',
            keeper: null,
        });

        expect(result).toEqual({
            players: [
                { name: 'Rohit Sharma', role: 'batsman' },
                { playerId: 'p2', name: 'Bumrah', role: 'bowler' },
            ],
            captain: 'Rohit Sharma',
            viceCaptain: 'Bumrah',
            keeper: null,
        });
    });

    it('rejects the same name differing only by case or whitespace', () => {
        expectCode(
            () => resolveSquad({ players: [{ name: 'Rohit', role: 'batsman' }, { name: ' rohit ', role: 'bowler' }] }),
            'SQUAD_PLAYER_NAMES_MUST_DIFFER'
        );
    });

    it('rejects captain and vice-captain being the same player', () => {
        expectCode(
            () => resolveSquad({ players: [{ name: 'Rohit', role: 'batsman' }], captain: 'Rohit', viceCaptain: 'ROHIT' }),
            'SQUAD_CAPTAIN_VC_MUST_DIFFER'
        );
    });

    it('allows the keeper to be the captain', () => {
        const result = resolveSquad({ players: [{ name: 'Rohit', role: 'batsman' }], captain: 'Rohit', keeper: 'Rohit' });
        expect(result.keeper).toBe('Rohit');
    });

    it('rejects a designation naming someone outside the squad', () => {
        expectCode(
            () => resolveSquad({ players: [{ name: 'Rohit', role: 'batsman' }], keeper: 'Pant' }),
            'SQUAD_DESIGNATION_NOT_IN_SQUAD'
        );
    });

    it.each(['wicketkeeper', 'unknown', 'x', undefined])('rejects role %s', (role) => {
        expectCode(() => resolveSquad({ players: [{ name: 'Rohit', role }] }), 'INVALID_ROLE');
    });

    it.each(['', '   ', 'a'.repeat(51), 7])('rejects invalid player name %p', (name) => {
        expectCode(() => resolveSquad({ players: [{ name, role: 'batsman' }] }), 'SQUAD_PLAYER_NAME_INVALID');
    });

    it('treats an empty squad with no designations as valid', () => {
        expect(resolveSquad({ players: [] })).toEqual({ players: [], captain: null, viceCaptain: null, keeper: null });
        expect(resolveSquad({})).toEqual({ players: [], captain: null, viceCaptain: null, keeper: null });
    });

    it('rejects a designation when the squad is empty', () => {
        expectCode(() => resolveSquad({ players: [], captain: 'Rohit' }), 'SQUAD_DESIGNATION_NOT_IN_SQUAD');
    });

    it('rejects a non-array players field', () => {
        expectCode(() => resolveSquad({ players: 'Rohit' }), 'SQUAD_PLAYER_NAME_INVALID');
    });
});
