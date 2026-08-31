import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replset;

/**
 * A real Mongo, in-process — not a mock. Lets controller tests exercise
 * actual Mongoose behavior (unique indexes, validators, and — the reason
 * this is a one-node REPLICA SET rather than a plain `MongoMemoryServer` —
 * multi-document transactions) instead of only the pure `resolveX` helpers,
 * which is what every existing scoring test was previously limited to (see
 * the backend CLAUDE.md's own note on this gap). `scoreBall`, `undoBall`,
 * `startInnings`, and `syncMatch` all call `session.withTransaction(...)`,
 * which a standalone `mongod` refuses outright — a plain `MongoMemoryServer`
 * hung every test that reached one rather than erroring, since the driver
 * just waits for replication acks a standalone instance never sends.
 */
export const connectTestDb = async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri());
};

export const disconnectTestDb = async () => {
  await mongoose.disconnect();
  if (replset) await replset.stop();
};

export const clearTestDb = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
};
