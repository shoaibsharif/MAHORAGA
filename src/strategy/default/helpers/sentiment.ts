/**
 * Sentiment analysis helpers for the default strategy.
 *
 * Pure functions — no side effects, no state.
 */

import { SOURCE_CONFIG } from "../config";

/**
 * Exponential time decay for posts/signals.
 * Uses half-life from SOURCE_CONFIG.decayHalfLifeMinutes.
 * Returns value clamped to [0.2, 1.0].
 */
export function calculateTimeDecay(postTimestamp: number): number {
  const ageMinutes = (Date.now() - postTimestamp * 1000) / 60000;
  const halfLife = SOURCE_CONFIG.decayHalfLifeMinutes;
  const decay = 0.5 ** (ageMinutes / halfLife);
  return Math.max(0.2, Math.min(1.0, decay));
}
