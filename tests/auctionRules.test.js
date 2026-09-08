import { nextBidAmount, LOT_TIMER_MS } from '../src/config/auctionRules.js';

describe('nextBidAmount', () => {
  it('adds 500 below 10,000', () => {
    expect(nextBidAmount(500)).toBe(1000);
    expect(nextBidAmount(9500)).toBe(10000);
  });

  it('adds 1,000 from 10,000 up to 49,999', () => {
    expect(nextBidAmount(10000)).toBe(11000);
    expect(nextBidAmount(49000)).toBe(50000);
  });

  it('adds 2,500 from 50,000 up to 99,999', () => {
    expect(nextBidAmount(50000)).toBe(52500);
    expect(nextBidAmount(97500)).toBe(100000);
  });

  it('adds 5,000 at 100,000 and above', () => {
    expect(nextBidAmount(100000)).toBe(105000);
    expect(nextBidAmount(1000000)).toBe(1005000);
  });
});

describe('LOT_TIMER_MS', () => {
  it('is 15 seconds', () => {
    expect(LOT_TIMER_MS).toBe(15000);
  });
});
