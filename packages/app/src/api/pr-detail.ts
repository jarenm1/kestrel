import { Schema } from "effect"

const User = Schema.NullOr(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String }))
export const PrDetail = Schema.Struct({
  number: Schema.Number, title: Schema.String, body: Schema.NullOr(Schema.String), state: Schema.String,
  draft: Schema.Boolean, author: User,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }), base: Schema.Struct({ ref: Schema.String }),
  comments: Schema.Array(Schema.Struct({ id: Schema.Number, body: Schema.String, author: User, createdAt: Schema.String, updatedAt: Schema.String })),
  contributors: Schema.Array(User), requestedReviewers: Schema.Array(User),
  requestedTeams: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
  reviews: Schema.Array(Schema.Struct({ id: Schema.Number, body: Schema.NullOr(Schema.String), author: User, state: Schema.String, submittedAt: Schema.NullOr(Schema.String) })),
  diff: Schema.String,
  inlineComments: Schema.Array(Schema.Struct({ id: Schema.Number, path: Schema.String, line: Schema.NullOr(Schema.Number), originalLine: Schema.NullOr(Schema.Number), author: User, body: Schema.String, createdAt: Schema.String, url: Schema.String })),
  checks: Schema.Struct({ runs: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String, conclusion: Schema.NullOr(Schema.String), url: Schema.NullOr(Schema.String) })),
    status: Schema.String, statuses: Schema.Array(Schema.Struct({ context: Schema.String, state: Schema.String, url: Schema.NullOr(Schema.String), description: Schema.NullOr(Schema.String) })) }),
  truncated: Schema.Struct({ comments: Schema.Boolean, reviews: Schema.Boolean, contributors: Schema.Boolean, checks: Schema.Boolean, statuses: Schema.Boolean, inlineComments: Schema.Boolean }),
})
export type PrDetail = typeof PrDetail.Type
