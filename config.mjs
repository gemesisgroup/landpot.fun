const number = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid configuration: ' + name);
  return value;
};

export const config = {
  tickMs: number('LANDPOT_TICK_MS', 500, 25, 1000),
  matchSeconds: number('LANDPOT_MATCH_SECONDS', 600, 1, 3600),
  queueSeconds: number('LANDPOT_QUEUE_SECONDS', 180, 1, 3600),
  reviewHours: number('LANDPOT_REVIEW_HOURS', 24, 1, 48),
  replayDays: number('LANDPOT_REPLAY_DAYS', 30, 1, 365),
  burnBps: number('LANDPOT_BURN_BPS', 200, 0, 2000),
  treasuryBps: number('LANDPOT_TREASURY_BPS', 300, 0, 2000),
  dailyPayout: number('LANDPOT_DAILY_PAYOUT', 5000, 1, 1_000_000),
  maxPot: number('LANDPOT_MAX_POT', 1600, 1, 1_000_000),
  paidMin: number('LANDPOT_PAID_MIN', 8, 8, 16),
  paidMax: number('LANDPOT_PAID_MAX', 16, 8, 16),
  freeMin: number('LANDPOT_FREE_MIN', 2, 2, 70),
  startingCredits: number('LANDPOT_STARTING_CREDITS', 1000, 0, 1_000_000),
  repeatPairs: number('LANDPOT_REPEAT_PAIRS', 5, 2, 100),
  regularTiming: number('LANDPOT_REGULAR_TIMING', 80, 10, 1000),
  timingDeviationMs: number('LANDPOT_TIMING_DEVIATION_MS', 3, 1, 100),
  stakes: {
    low: { stake: number('LANDPOT_LOW_STAKE', 20, 1, 100_000), games: 0, rating: 0 },
    mid: { stake: number('LANDPOT_MID_STAKE', 50, 1, 100_000), games: number('LANDPOT_MID_GAMES', 10, 1, 10000), rating: number('LANDPOT_MID_RATING', 1050, 0, 3000) },
    high: { stake: number('LANDPOT_HIGH_STAKE', 100, 1, 100_000), games: number('LANDPOT_HIGH_GAMES', 30, 1, 10000), rating: number('LANDPOT_HIGH_RATING', 1150, 0, 3000) },
  },
};
if (config.paidMin > config.paidMax) throw new Error('Paid minimum exceeds maximum');
