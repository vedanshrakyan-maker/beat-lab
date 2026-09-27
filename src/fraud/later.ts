/**
 * DESIGNED FOR LATER — interfaces only, not implemented in v0.1 (see docs/ROADMAP.md).
 * Each would plug in as a normal FraudRule once its data source exists.
 */

/** TODO: perceptual hashes of thumbnails / sampled frames to catch re-uploads across accounts. */
export interface PerceptualHasher {
  hashFrames(videoUrl: string): Promise<string[]>;
  /** Hamming-distance search against previously seen hashes. */
  findNearDuplicates(
    hashes: string[],
    maxDistance: number,
  ): Promise<{ submissionId: string; distance: number }[]>;
}

/** TODO: audience geography (e.g. an India campaign whose audience is mostly outside India). */
export interface AudienceGeoProvider {
  countryShare(platformAccountId: string): Promise<Record<string, number>>;
}

/** TODO: classify generic bot comments ("nice video", emoji-only, copy-paste). */
export interface CommentQualityClassifier {
  botCommentShare(comments: string[]): Promise<number>;
}

/** TODO: clipper trust tiers — longer holds for new clippers, faster payouts for trusted ones. */
export type TrustTier = "NEW" | "STANDARD" | "TRUSTED";
export interface TrustTierPolicy {
  tierFor(userId: string): Promise<TrustTier>;
  holdPeriodDays(tier: TrustTier, campaignDefault: number): number;
}
