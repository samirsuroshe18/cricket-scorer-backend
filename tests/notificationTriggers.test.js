import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Player } from '../src/models/player.model.js';
import { Notification } from '../src/models/notification.model.js';

// Covers the notification hooks added to startInnings/scoreBall/
// selectBowler/assignScorer — see docs/api.md and notify.js's own comments
// for the design (best-effort, post-commit only, never blocks the write
// it's attached to).
describe('notification triggers', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true, withPlayer: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const claimPlayer = (token, playerId) =>
    request(app).post(`/api/v1/player/${playerId}/claim`).set('Authorization', `Bearer ${token}`).send();

  const unclaimPlayer = (token, playerId) =>
    request(app).post(`/api/v1/player/${playerId}/unclaim`).set('Authorization', `Bearer ${token}`).send();

  const selectBowler = (token, matchId, bowlerName) =>
    request(app).post(`/api/v1/match/${matchId}/select-bowler`).set('Authorization', `Bearer ${token}`).send({ bowlerName });

  const assignScorer = (token, matchId, scorerId) =>
    request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${token}`).send({ scorerId });

  describe('match_started', () => {
    it("notifies the creator when their assigned scorer starts the match, not the scorer themselves", async () => {
      const { token: ownerToken, user: owner } = await createTestUser({ email: 'msowner@example.com' });
      const { token: scorerToken, user: scorer } = await createTestUser({ email: 'msscorer@example.com' });
      const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'MS Org' });
      const orgId = orgRes.body.data.id;
      await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: 'msscorer@example.com' });
      const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'MS Team' });
      const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
      await assignScorer(ownerToken, matchId, String(scorer._id));

      await startLiveInnings(app, scorerToken, matchId);

      const creatorNotification = await Notification.findOne({ recipient: owner._id, type: 'match_started' });
      expect(creatorNotification).not.toBeNull();
      expect(creatorNotification.data.matchId).toBe(matchId);
      const scorerNotification = await Notification.findOne({ recipient: scorer._id, type: 'match_started' });
      expect(scorerNotification).toBeNull();
    });

    it('sends no match_started notification for a solo, non-delegated match', async () => {
      const { token } = await createTestUser({ email: 'solo-ms@example.com' });
      const matchId = await createMatch(app, token);

      await startLiveInnings(app, token, matchId);

      const count = await Notification.countDocuments({ type: 'match_started' });
      expect(count).toBe(0);
    });
  });

  describe('your_turn_to_bat / your_turn_to_bowl — openers', () => {
    it('notifies a claimed opening striker and bowler; sends nothing for the unclaimed non-striker', async () => {
      const { token } = await createTestUser({ email: 'openers-scorer@example.com' });
      const { token: batterToken, user: batter } = await createTestUser({ email: 'opener-batter@example.com' });
      const { token: bowlerAccToken, user: bowlerAcc } = await createTestUser({ email: 'opener-bowler@example.com' });

      // First match: creates the Player docs for these names under this
      // scorer (findOrCreatePlayer upserts on {createdBy, nameLower}).
      const seedMatchId = await createMatch(app, token, { teamAName: 'Seed A', teamBName: 'Seed B' });
      await startLiveInnings(app, token, seedMatchId, {
        strikerName: 'Claimable Striker',
        nonStrikerName: 'Unclaimed NonStriker',
        bowlerName: 'Claimable Bowler',
      });

      const strikerPlayer = await Player.findOne({ createdBy: (await Match.findById(seedMatchId)).createdBy, nameLower: 'claimable striker' });
      const bowlerPlayer = await Player.findOne({ createdBy: (await Match.findById(seedMatchId)).createdBy, nameLower: 'claimable bowler' });

      await claimPlayer(batterToken, strikerPlayer._id);
      await claimPlayer(bowlerAccToken, bowlerPlayer._id);
      await Notification.deleteMany({});

      // Second match, same scorer, same names — findOrCreatePlayer resolves
      // to the SAME (now-claimed) Player docs.
      const matchId = await createMatch(app, token, { teamAName: 'Real A', teamBName: 'Real B' });
      await startLiveInnings(app, token, matchId, {
        strikerName: 'Claimable Striker',
        nonStrikerName: 'Unclaimed NonStriker',
        bowlerName: 'Claimable Bowler',
      });

      const batNotification = await Notification.findOne({ recipient: batter._id, type: 'your_turn_to_bat' });
      expect(batNotification).not.toBeNull();
      expect(batNotification.data.matchId).toBe(matchId);

      const bowlNotification = await Notification.findOne({ recipient: bowlerAcc._id, type: 'your_turn_to_bowl' });
      expect(bowlNotification).not.toBeNull();

      // The non-striker was never claimed by anyone — no recipient exists,
      // so nothing was (or could have been) sent for them.
      const totalNotifications = await Notification.countDocuments({});
      expect(totalNotifications).toBe(2);
    });
  });

  describe('your_turn_to_bat — mid-innings incoming batsman', () => {
    it('notifies a claimed incoming batsman after a wicket, only from the online scoreBall path', async () => {
      const { token } = await createTestUser({ email: 'incoming-scorer@example.com' });
      const { token: incomingToken, user: incoming } = await createTestUser({ email: 'incoming-batter@example.com' });

      const seedMatchId = await createMatch(app, token, { teamAName: 'Seed A2', teamBName: 'Seed B2' });
      await startLiveInnings(app, token, seedMatchId, { strikerName: 'First Striker' });
      const strikerBefore = await scoreDotBall(app, token, seedMatchId, {
        wicketType: 'bowled',
        dismissedBatsman: 'striker',
        incomingBatsmanName: 'Incoming Claimable',
      });
      expect(strikerBefore.status).toBe(200);

      const seedMatch = await Match.findById(seedMatchId);
      const incomingPlayer = await Player.findOne({ createdBy: seedMatch.createdBy, nameLower: 'incoming claimable' });
      await claimPlayer(incomingToken, incomingPlayer._id);
      await Notification.deleteMany({});

      const matchId = await createMatch(app, token, { teamAName: 'Real A2', teamBName: 'Real B2' });
      await startLiveInnings(app, token, matchId, { strikerName: 'First Striker' });
      const res = await scoreDotBall(app, token, matchId, {
        wicketType: 'bowled',
        dismissedBatsman: 'striker',
        incomingBatsmanName: 'Incoming Claimable',
      });
      expect(res.status).toBe(200);

      const notification = await Notification.findOne({ recipient: incoming._id, type: 'your_turn_to_bat' });
      expect(notification).not.toBeNull();
      expect(notification.data.matchId).toBe(matchId);
    });
  });

  describe('your_turn_to_bowl — mid-innings bowler change', () => {
    it('notifies a claimed newly-selected bowler for the next over', async () => {
      const { token } = await createTestUser({ email: 'newbowler-scorer@example.com' });
      const { token: newBowlerToken, user: newBowlerUser } = await createTestUser({ email: 'new-bowler@example.com' });

      const seedMatchId = await createMatch(app, token, { teamAName: 'Seed A3', teamBName: 'Seed B3', totalOvers: 5 });
      await startLiveInnings(app, token, seedMatchId, { bowlerName: 'First Over Bowler' });
      for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, token, seedMatchId);
      }
      await selectBowler(token, seedMatchId, 'Claimable Second Bowler');

      const seedMatch = await Match.findById(seedMatchId);
      const bowlerPlayer = await Player.findOne({ createdBy: seedMatch.createdBy, nameLower: 'claimable second bowler' });
      await claimPlayer(newBowlerToken, bowlerPlayer._id);
      await Notification.deleteMany({});

      const matchId = await createMatch(app, token, { teamAName: 'Real A3', teamBName: 'Real B3', totalOvers: 5 });
      await startLiveInnings(app, token, matchId, { bowlerName: 'First Over Bowler' });
      for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, token, matchId);
      }
      const res = await selectBowler(token, matchId, 'Claimable Second Bowler');
      expect(res.status).toBe(200);

      const notification = await Notification.findOne({ recipient: newBowlerUser._id, type: 'your_turn_to_bowl' });
      expect(notification).not.toBeNull();
      expect(notification.data.matchId).toBe(matchId);
    });
  });

  describe('claim / unclaim', () => {
    it('lets a claimed player unclaim themselves, and rejects an unclaim from anyone else', async () => {
      const { token } = await createTestUser({ email: 'claim-scorer@example.com' });
      const { token: claimerToken, user: claimer } = await createTestUser({ email: 'claimer@example.com' });
      const { token: otherToken } = await createTestUser({ email: 'other-claimer@example.com' });

      const matchId = await createMatch(app, token, { teamAName: 'Claim A', teamBName: 'Claim B' });
      await startLiveInnings(app, token, matchId, { strikerName: 'Claim Target' });
      const match = await Match.findById(matchId);
      const player = await Player.findOne({ createdBy: match.createdBy, nameLower: 'claim target' });

      const claimRes = await claimPlayer(claimerToken, player._id);
      expect(claimRes.status).toBe(200);
      expect(claimRes.body.data.linkedUserId).toBe(String(claimer._id));

      const rejectedUnclaim = await unclaimPlayer(otherToken, player._id);
      expect(rejectedUnclaim.status).toBe(403);
      expect(rejectedUnclaim.body.code).toBe('PLAYER_NOT_LINKED_TO_YOU');

      const unclaimRes = await unclaimPlayer(claimerToken, player._id);
      expect(unclaimRes.status).toBe(200);
      expect(unclaimRes.body.data.linkedUserId).toBeNull();

      const reclaimByOther = await claimPlayer(otherToken, player._id);
      expect(reclaimByOther.status).toBe(200);
    });

    it('rejects claiming a player someone else has already claimed', async () => {
      const { token } = await createTestUser({ email: 'claim-scorer2@example.com' });
      const { token: firstToken } = await createTestUser({ email: 'first-claimer@example.com' });
      const { token: secondToken } = await createTestUser({ email: 'second-claimer@example.com' });

      const matchId = await createMatch(app, token, { teamAName: 'Claim2 A', teamBName: 'Claim2 B' });
      await startLiveInnings(app, token, matchId, { strikerName: 'Contested Target' });
      const match = await Match.findById(matchId);
      const player = await Player.findOne({ createdBy: match.createdBy, nameLower: 'contested target' });

      await claimPlayer(firstToken, player._id);
      const res = await claimPlayer(secondToken, player._id);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PLAYER_ALREADY_CLAIMED');
    });

    it('rejects claiming a nonexistent player', async () => {
      const { token } = await createTestUser({ email: 'claim-scorer3@example.com' });

      const res = await claimPlayer(token, '000000000000000000000000');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PLAYER_NOT_FOUND');
    });
  });
});
