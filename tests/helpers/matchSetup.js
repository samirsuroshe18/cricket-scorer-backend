import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Match } from '../../src/models/match.model.js';
import { Team } from '../../src/models/team.model.js';
import { Player } from '../../src/models/player.model.js';

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

// Finds-or-creates a Player by (createdBy, name) — same key findOrCreatePlayerRecord
// uses in the controller, so a name given here is the exact Player start-innings
// itself will resolve — and rosters it onto `teamId`. Test-setup plumbing only:
// writes straight to Mongo rather than through an endpoint, since this exists
// purely to get a side into a state a real scorer would have reached via the
// Squad screen, not to exercise that screen's own endpoints.
const ensureRosteredPlayer = async (createdBy, teamId, name) => {
  const nameLower = name.trim().toLowerCase();
  const player = await Player.findOneAndUpdate(
    { createdBy, nameLower },
    { $setOnInsert: { name, nameLower, createdBy } },
    { upsert: true, returnDocument: 'after' }
  );
  await Team.updateOne({ _id: teamId }, { $addToSet: { players: player._id } });
  return player;
};

// Ensures `side`'s Playing XI already contains a Player for each of `names`,
// on top of whatever it already holds, then tops it up with a side-dedicated
// filler player if that is still short of the match's minimum. Used by
// startLiveInnings below so tests written before start-innings required a
// saved Playing XI on both sides keep working unchanged.
const ensurePlayingXiForNames = async (match, side, names) => {
  const teamId = match[side];
  const squad = match.squads?.[side] ?? {};
  const currentIds = (squad.playingXI ?? []).map(String);
  const currentPlayers = (squad.players ?? []).map(String);

  const added = [];
  for (const name of names) {
    added.push(await ensureRosteredPlayer(match.createdBy, teamId, name));
  }

  let xi = [...new Set([...currentIds, ...added.map((p) => String(p._id))])];
  if (xi.length < match.minPlayingXi) {
    const filler = await ensureRosteredPlayer(match.createdBy, teamId, `XI Filler ${side}`);
    xi = [...new Set([...xi, String(filler._id)])];
  }
  const players = [...new Set([...currentPlayers, ...xi])];

  await Match.updateOne({ _id: match._id }, {
    $set: { [`squads.${side}.players`]: players, [`squads.${side}.playingXI`]: xi },
  });
};

/**
 * Starts innings 1 (or 2, on a match already past the transition) with named
 * openers and an opening bowler, exactly as a real client's first call would.
 * start-innings requires both sides to already have a saved, in-range Playing
 * XI (see docs/api.md), so this first makes sure of that: for each of
 * striker/non-striker/bowler, unless the call also passes that role's own
 * `*Id` (meaning the caller is relying on an XI it already set up itself —
 * see openerPlayerIdSelection.test.js's id-disambiguation calls), the named
 * player is rostered and folded into the right side's XI, batting or bowling
 * as `match.battingFirst`/`currentInnings` currently has it. Returns the
 * parsed response body's `data`.
 */
export const startLiveInnings = async (app, token, matchId, overrides = {}) => {
  const striker = overrides.strikerName ?? 'Striker';
  const nonStriker = overrides.nonStrikerName ?? 'Non-Striker';
  const bowler = overrides.bowlerName ?? 'Bowler One';

  const match = await Match.findById(matchId);
  if (match) {
    const firstBattingTeam = match.battingFirst || 'teamA';
    const battingTeam = match.currentInnings === 2
      ? (firstBattingTeam === 'teamA' ? 'teamB' : 'teamA')
      : firstBattingTeam;
    const bowlingTeam = battingTeam === 'teamA' ? 'teamB' : 'teamA';

    const battingNames = [
      ...(overrides.strikerId == null ? [striker] : []),
      ...(overrides.nonStrikerId == null ? [nonStriker] : []),
    ];
    const bowlingNames = overrides.bowlerId == null ? [bowler] : [];

    if (battingNames.length) await ensurePlayingXiForNames(match, battingTeam, battingNames);
    if (bowlingNames.length) await ensurePlayingXiForNames(match, bowlingTeam, bowlingNames);
  }

  const res = await request(app)
    .post(`/api/v1/match/${matchId}/start-innings`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      strikerName: striker,
      nonStrikerName: nonStriker,
      bowlerName: bowler,
      ...overrides,
    });
  return res.body.data;
};

/**
 * Adds `name` to `side`'s Playing XI via the real PATCH endpoint, rostering
 * it first if needed — for any test that introduces a player mid-match
 * (an incoming batsman, a new bowler) who was not part of the XI
 * startLiveInnings set up. Mirrors what a real scorer now has to do first:
 * "That player is not in the Playing XI. Move them into the XI first." Pads
 * with a side-dedicated filler when `side` had no prior XI at all — a lone
 * addition would otherwise leave it at size 1, below this match's minimum.
 *
 * `createdBy` defaults to the match's own creator, matching the identity
 * namespace an ordinary same-user test runs in. Pass the acting user's own
 * id explicitly on a delegated-scorer match: a later by-id lookup (e.g.
 * resolveBowler's `Player.findOne({ _id, createdBy: req.user._id })`) is
 * scoped to whoever's token makes THAT call, which is not always the
 * match's creator.
 */
export const addPlayerToXi = async (app, token, matchId, side, name, createdBy) => {
  const match = await Match.findById(matchId);
  const owner = createdBy ?? match.createdBy;
  const player = await ensureRosteredPlayer(owner, match[side], name);
  let ids = [...new Set([...(match.squads?.[side]?.playingXI ?? []).map(String), String(player._id)])];

  if (ids.length < match.minPlayingXi) {
    const filler = await ensureRosteredPlayer(owner, match[side], `XI Filler ${side}`);
    ids = [...new Set([...ids, String(filler._id)])];
  }

  await request(app)
    .patch(`/api/v1/match/${matchId}/squad/${side}/playing-xi`)
    .set('Authorization', `Bearer ${token}`)
    .send({ playingXI: ids });

  return player;
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
