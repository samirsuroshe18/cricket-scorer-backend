// Fixed system-wide constants for the live auction room — organizer
// configurability is explicitly deferred (see the design spec's "Explicitly
// out of scope this phase"). Centralized here so a future change touches
// one file.

export const LOT_TIMER_MS = 15000;

const INCREMENT_TIERS = [
    { belowExclusive: 10000, increment: 500 },
    { belowExclusive: 50000, increment: 1000 },
    { belowExclusive: 100000, increment: 2500 },
];
const TOP_TIER_INCREMENT = 5000;

export const nextBidAmount = (currentBid) => {
    const tier = INCREMENT_TIERS.find((t) => currentBid < t.belowExclusive);
    const increment = tier ? tier.increment : TOP_TIER_INCREMENT;
    return currentBid + increment;
};
