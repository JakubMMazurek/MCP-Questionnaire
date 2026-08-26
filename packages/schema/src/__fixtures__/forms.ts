/**
 * Test fixtures. `kitchenSink` exercises every §4.2 field type in one valid
 * form; `minimal` is the smallest form worth rendering and is the base the
 * per-check tests mutate.
 *
 * They are written as plain JSON-shaped literals — exactly what arrives as tool
 * input — and rebuilt per call, so a test that mutates one cannot affect another.
 */

/** A valid form using every field type, with no warnings. */
export function kitchenSink(): Record<string, unknown> {
  return {
    version: 1,
    title: "Before I draft the rollout plan…",
    description: "I inferred these from our conversation. Fix anything wrong — or confirm the lot.",
    display: "fullscreen",
    submitLabel: "Looks right — go",
    sections: [
      {
        id: "scope",
        title: "Scope",
        fields: [
          {
            id: "region",
            label: "Which org are we rolling out to?",
            type: "single_select",
            render: "segmented",
            options: [
              { value: "eu", label: "EU org only" },
              { value: "global", label: "Everything" },
            ],
            skipOptions: [{ value: "lets_talk", label: "Let's talk" }],
          },
          {
            id: "addons",
            label: "Which extras ship with it?",
            type: "multi_select",
            render: "chips",
            options: [
              { value: "gdpr_pack", label: "GDPR pack" },
              { value: "audit_log", label: "Audit log" },
            ],
          },
          {
            id: "dryRun",
            label: "Dry run first?",
            type: "boolean",
            render: "toggle",
            trueLabel: "Dry run",
            falseLabel: "Straight to it",
          },
        ],
      },
      {
        id: "tradeoffs",
        title: "Tradeoffs",
        layout: "two_col",
        fields: [
          {
            id: "thoroughness",
            label: "Speed ↔ thoroughness",
            type: "slider",
            min: 0,
            max: 10,
            step: 1,
            minLabel: "fast",
            maxLabel: "exhaustive",
          },
          {
            id: "effort",
            label: "Split the effort",
            type: "allocation",
            total: 100,
            unit: "%",
            members: [
              { id: "migration", label: "Migration" },
              { id: "testing", label: "Testing" },
            ],
          },
          {
            id: "batchSize",
            label: "Records per batch",
            type: "number",
            min: 1,
            max: 5000,
            step: 1,
            unit: "records",
          },
          {
            id: "priorities",
            label: "Order the workstreams",
            type: "rank",
            items: [
              { id: "data", label: "Data migration" },
              { id: "perms", label: "Permissions" },
              { id: "comms", label: "Comms" },
            ],
          },
        ],
      },
      {
        id: "timing",
        title: "Timing",
        initially: "collapsed",
        fields: [
          {
            id: "cutover",
            label: "Cutover date",
            type: "date",
            presets: [
              { value: "2026-09-30", label: "End of Q3" },
              { value: "2026-08-29", label: "Next weekend" },
            ],
            skipOptions: [{ value: "tbd", label: "TBD" }],
          },
          {
            id: "freeze",
            label: "Change freeze",
            type: "date_range",
            min: "2026-08-01",
            max: "2026-12-31",
          },
          {
            id: "codeName",
            label: "Name this rollout",
            type: "short_text",
            maxLength: 40,
          },
          {
            id: "notes",
            label: "Anything I have missed?",
            type: "long_text",
            placeholder: "Optional",
          },
        ],
      },
      {
        id: "detail",
        title: "Detail",
        fields: [
          {
            id: "plan",
            type: "info",
            label: "The plan as it stands",
            markdown: "## Rollout\n1. Freeze discount codes\n2. Migrate accounts\n3. Cut over",
          },
          {
            id: "fls",
            label: "Discount fields — profile access",
            type: "matrix",
            cellType: "single_select",
            render: "cycle",
            rows: [
              { id: "Discount__c", label: "Discount" },
              { id: "Margin__c", label: "Margin" },
            ],
            cols: [
              { id: "SalesOps", label: "Sales Ops" },
              { id: "RevOps", label: "Rev Ops" },
            ],
            cellOptions: [
              { value: "-", label: "Hidden" },
              { value: "R", label: "Read" },
              { value: "RW", label: "Read/write" },
            ],
            constraints: [
              {
                row: "Discount__c",
                col: "RevOps",
                allowed: ["R"],
                reason: "Formula field — read-only in this profile",
              },
            ],
          },
          {
            id: "stakeholders",
            label: "Who signs off?",
            type: "repeatable",
            addLabel: "Add another stakeholder",
            min: 1,
            fields: [
              { id: "owner", label: "Name", type: "short_text" },
              {
                id: "role",
                label: "Role",
                type: "single_select",
                options: [
                  { value: "approver", label: "Approver" },
                  { value: "informed", label: "Informed" },
                ],
              },
            ],
          },
          {
            id: "ledger",
            label: "Assumptions",
            type: "table",
            columns: [
              {
                id: "verdict",
                label: "Verdict",
                type: "single_select",
                render: "segmented",
                options: [
                  { value: "confirm", label: "Confirm" },
                  { value: "fix", label: "Fix" },
                  { value: "lets_talk", label: "Let's talk" },
                ],
              },
              { id: "fix", label: "What it should say", type: "short_text" },
            ],
            rows: [
              {
                id: "r_7f3a",
                label: "Rollout targets the EU org only",
                description: "you mentioned EU customers twice",
              },
              {
                id: "r_91bc",
                label: "Sales Ops keeps edit access during migration",
                description: "current profile config",
              },
            ],
          },
          {
            id: "unresolved",
            label: "Marked “let's talk”",
            type: "computed",
            compute: {
              op: "count_value",
              targets: ["ledger.verdict"],
              value: "lets_talk",
            },
          },
        ],
      },
    ],
    rules: [
      {
        when: { field: "region", op: "eq", value: "eu" },
        then: { action: "show", targets: ["timing"] },
      },
      {
        when: { field: "dryRun", op: "eq", value: false },
        then: { action: "require", targets: ["cutover"] },
      },
      {
        when: { field: "$self.verdict", op: "eq", value: "fix" },
        then: { action: "show", targets: ["$self.fix"] },
      },
      {
        when: { field: "region", op: "eq", value: "eu" },
        then: {
          action: "filter_options",
          targets: ["addons"],
          options: ["gdpr_pack"],
        },
      },
      {
        when: { field: "batchSize", op: "gt", value: 1000 },
        then: {
          action: "set_default",
          targets: ["notes"],
          value: "Large batch — say why.",
        },
      },
    ],
    prefill: {
      region: {
        value: "eu",
        source: "inferred",
        confidence: "low",
        rationale: "you mentioned EU customers twice",
        needsReview: true,
      },
      dryRun: { value: true, source: "default" },
      "ledger[r_7f3a].verdict": {
        value: "confirm",
        source: "inferred",
        confidence: "high",
        rationale: "you said the EU org is the pilot",
      },
      "fls[Discount__c][SalesOps]": { value: "RW", source: "existing" },
    },
  };
}

/** The smallest form worth rendering: two sections, two fields each, prefilled. */
export function minimal(): Record<string, unknown> {
  return {
    version: 1,
    title: "Quick setup for the data migration",
    display: "inline",
    sections: [
      {
        id: "setup",
        title: "Setup",
        fields: [
          {
            id: "env",
            label: "Environment",
            type: "single_select",
            render: "segmented",
            options: [
              { value: "sandbox", label: "Sandbox" },
              { value: "prod", label: "Production" },
            ],
            skipOptions: [{ value: "you_decide", label: "You decide" }],
          },
          {
            id: "scopeChoice",
            label: "Scope",
            type: "single_select",
            options: [
              { value: "accounts", label: "Accounts only" },
              { value: "everything", label: "Everything" },
            ],
          },
        ],
      },
      {
        id: "timing",
        title: "Timing",
        fields: [
          { id: "cutover", label: "Cutover", type: "date" },
          { id: "notes", label: "Notes", type: "long_text" },
        ],
      },
    ],
    prefill: {
      env: {
        value: "sandbox",
        source: "inferred",
        confidence: "low",
        rationale: "you mentioned the July sandbox refresh",
      },
    },
  };
}
