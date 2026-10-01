// Job-costing buckets of expense categories (A§2, A§10, D41). Plain data: the schema and client components use it.
export const COST_BUCKETS = ["material", "labour", "printing", "installation", "transport", "other", "none"] as const;
export type CostBucket = (typeof COST_BUCKETS)[number];

export const BUCKET_LABEL: Record<CostBucket, string> = {
  material: "Material",
  labour: "Labour",
  printing: "Printing",
  installation: "Installation",
  transport: "Transport",
  other: "Other",
  none: "None (overhead)",
};

/** The job P&L buckets (S3, S11), in card order. A "none" category tagged to a job counts as other (D57). */
export const JOB_COST_BUCKETS = ["material", "labour", "installation", "transport", "printing", "other"] as const;
export type JobCostBucket = (typeof JOB_COST_BUCKETS)[number];
