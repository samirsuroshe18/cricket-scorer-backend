import request from 'supertest';
import { randomUUID } from 'node:crypto';

/**
 * Creates a match (5 overs by default) and returns its id. Thin wrapper over
 * the real `create` endpoint — every scoring test needs a real match to hang
 * off, never a hand-built Mongo document.
 */
export const createMatch = async (app, token, overrides = {}) => {
  const res = await request(app)
    .post('/api/v1/match/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      teamAName: 'Team A',
      teamBName: 'Team B',
      totalOvers: 5,
      ...overrides,
    });
  return res.body.data.matchId;
};

/**
 * Starts innings 1 with named openers and an opening bowler, exactly as a
 * real client's first call would. Returns the parsed response body's `data`.
 */
export const startLiveInnings = async (app, token, matchId, overrides = {}) => {
  const res = await request(app)
    .post(`/api/v1/match/${matchId}/start-innings`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      strikerName: 'Striker',
      nonStrikerName: 'Non-Striker',
      bowlerName: 'Bowler One',
      ...overrides,
    });
  return res.body.data;
};

/**
 * Scores one dot ball (0 runs, no extra, no wicket) with a fresh
 * idempotencyKey. The default shape every "just advance the innings" test
 * case needs; pass `overrides` for anything else.
 */
export const scoreDotBall = (app, token, matchId, overrides = {}) =>
  request(app)
    .post(`/api/v1/match/${matchId}/score-ball`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      runs: 0,
      idempotencyKey: randomUUID(),
      ...overrides,
    });
