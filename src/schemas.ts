import { z } from "zod";

export const repoParamsSchema = z.object({ owner: z.string().min(1), repository: z.string().min(1) });
export const issueNumberSchema = z.coerce.number().int().positive();
export const releaseIdSchema = z.coerce.number().int().positive();
export const runIdSchema = z.coerce.number().int().positive();

export const createBranchSchema = z.object({
  name: z.string().min(1),
  fromRef: z.string().min(1).default("main")
});

export const confirmationSchema = z.object({ confirmation: z.string().min(1) });

export const createPullSchema = z.object({
  title: z.string().min(1).max(256),
  head: z.string().min(1),
  base: z.string().min(1),
  body: z.string().optional(),
  draft: z.boolean().default(true),
  maintainerCanModify: z.boolean().default(true),
  changePlanId: z.uuid().optional()
});

export const updatePullSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]).optional(),
  base: z.string().optional(),
  maintainerCanModify: z.boolean().optional()
});

export const mergePullSchema = z.object({
  commitTitle: z.string().max(256).optional(),
  commitMessage: z.string().max(65536).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
  expectedHeadSha: z.string().optional(),
  confirmation: z.string().min(1)
});

export const commentSchema = z.object({ body: z.string().min(1).max(65536) });

export const reviewersSchema = z.object({
  reviewers: z.array(z.string()).default([]),
  teamReviewers: z.array(z.string()).default([])
});

export const createReviewSchema = z.object({
  body: z.string().optional(),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).default("COMMENT"),
  commitId: z.string().optional(),
  comments: z.array(z.object({
    path: z.string(),
    position: z.number().int().positive().optional(),
    line: z.number().int().positive().optional(),
    side: z.enum(["LEFT", "RIGHT"]).optional(),
    body: z.string()
  })).optional()
});

export const createIssueSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.union([z.string(), z.number()])).optional(),
  milestone: z.number().int().positive().nullable().optional()
});

export const updateIssueSchema = createIssueSchema.partial().extend({
  state: z.enum(["open", "closed"]).optional(),
  stateReason: z.enum(["completed", "not_planned", "reopened"]).optional()
});

export const createLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
  description: z.string().max(100).optional()
});

export const updateLabelSchema = z.object({
  newName: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
  description: z.string().max(100).nullable().optional()
});

export const dispatchWorkflowSchema = z.object({
  ref: z.string().min(1),
  inputs: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).default({})
});

export const createReleaseSchema = z.object({
  tagName: z.string().min(1),
  targetCommitish: z.string().optional(),
  name: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().default(true),
  prerelease: z.boolean().default(false),
  generateReleaseNotes: z.boolean().default(false)
});

export const updateReleaseSchema = createReleaseSchema.partial();

export const createTagSchema = z.object({
  tag: z.string().min(1),
  targetSha: z.string().min(7),
  message: z.string().optional(),
  type: z.enum(["commit", "tree", "blob"]).default("commit"),
  annotated: z.boolean().default(false),
  tagger: z.object({ name: z.string(), email: z.email(), date: z.iso.datetime().optional() }).optional()
});

export const repositorySettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  confirmation: z.string().min(1)
});

export const collaboratorSchema = z.object({
  permission: z.enum(["pull", "triage", "push", "maintain", "admin"]).default("push"),
  confirmation: z.string().min(1)
});

export const branchProtectionSchema = z.object({
  protection: z.record(z.string(), z.unknown()),
  confirmation: z.string().min(1)
});
