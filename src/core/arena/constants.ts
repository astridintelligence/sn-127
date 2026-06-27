/** Percentage of total subnet emissions allocated per competition (0–100). */
export const EMISSIONS_PERCENT = 30;

/** Fraction of the competition's emission allocation given to each rank (top 3). */
export const EMISSION_SPLITS: readonly number[] = [0.6, 0.3, 0.1];

/** Maximum number of miners that receive emissions per competition. */
export const TOP_N = 3;
