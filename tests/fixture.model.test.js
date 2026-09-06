import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Fixture } from '../src/models/fixture.model.js';

beforeAll(async () => {
    await connectTestDb();
    await Fixture.init();
});

afterEach(async () => {
    await clearTestDb();
});

afterAll(async () => {
    await disconnectTestDb();
});

describe('Fixture model', () => {
    it('creates a scheduled fixture with two teams', async () => {
        const tournamentId = new mongoose.Types.ObjectId();
        const teamA = new mongoose.Types.ObjectId();
        const teamB = new mongoose.Types.ObjectId();

        const fixture = await Fixture.create({
            tournament: tournamentId,
            round: 1,
            order: 0,
            teamA,
            teamB,
        });

        expect(fixture.status).toBe('scheduled');
        expect(fixture.isBye).toBe(false);
        expect(fixture.match).toBeNull();
        expect(fixture.winner).toBeNull();
    });

    it('allows teamB to be null for a bye fixture', async () => {
        const fixture = await Fixture.create({
            tournament: new mongoose.Types.ObjectId(),
            round: 1,
            order: 0,
            teamA: new mongoose.Types.ObjectId(),
            teamB: null,
            isBye: true,
            status: 'bye',
        });

        expect(fixture.teamB).toBeNull();
        expect(fixture.status).toBe('bye');
    });

    it('rejects an invalid status value', async () => {
        const fixture = new Fixture({
            tournament: new mongoose.Types.ObjectId(),
            round: 1,
            order: 0,
            teamA: new mongoose.Types.ObjectId(),
            teamB: new mongoose.Types.ObjectId(),
            status: 'not-a-real-status',
        });

        await expect(fixture.validate()).rejects.toThrow();
    });

    it('requires teamA', async () => {
        const fixture = new Fixture({
            tournament: new mongoose.Types.ObjectId(),
            round: 1,
            order: 0,
            teamB: new mongoose.Types.ObjectId(),
        });

        await expect(fixture.validate()).rejects.toThrow();
    });
});
