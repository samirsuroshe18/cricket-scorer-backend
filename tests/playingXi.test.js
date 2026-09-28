import { mergePlayingXi } from '../src/utils/playingXi.js';

describe('mergePlayingXi', () => {
    it('uses a requested array as given', () => {
        expect(mergePlayingXi({ requested: ['a'], existing: ['b'], savedIds: ['a', 'b'] })).toEqual(['a']);
    });

    it('un-sets on null', () => {
        expect(mergePlayingXi({ requested: null, existing: ['a'], savedIds: ['a'] })).toBeUndefined();
    });

    it('keeps the existing XI on undefined, dropping players no longer in the squad', () => {
        expect(mergePlayingXi({ requested: undefined, existing: ['a', 'b'], savedIds: ['b', 'c'] })).toEqual(['b']);
    });

    it('stays unset when nothing was requested and nothing was stored', () => {
        expect(mergePlayingXi({ requested: undefined, existing: undefined, savedIds: ['a'] })).toBeUndefined();
    });

    it('keeps an empty XI empty, distinct from unset', () => {
        expect(mergePlayingXi({ requested: undefined, existing: [], savedIds: ['a'] })).toEqual([]);
    });
});
