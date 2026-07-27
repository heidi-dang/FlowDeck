export const SCORING_VERSION = "1.0.0";

export function formatScoreWithVersion(
  score: number,
  scoringVersion?: string,
): { score: number; scoringVersion: string } {
  return {
    score,
    scoringVersion: scoringVersion ?? SCORING_VERSION,
  };
}
