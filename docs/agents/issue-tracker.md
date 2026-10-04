# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `jnslmk/OpenRailTransitmap`. Use the `gh` CLI from this clone; outside it, pass `--repo jnslmk/OpenRailTransitmap`.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,comments,labels,assignees,state,url`.
- List: `gh issue list --state open --limit 100 --json number,title,body,labels,assignees,url`; paginate the API if the limit is reached.
- Comment: `gh issue comment <number> --body-file <file>`.
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`; use `docs/agents/triage-labels.md` for canonical roles.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Close: `gh issue close <number> --reason completed --comment "..."`; use `--reason "not planned"` for declined work.
- Reopen: `gh issue reopen <number> --comment "..."`.

Read the full issue and comments before changing its scope or disposition. When a skill says publish to the tracker, create a GitHub issue; when it says fetch a ticket, retrieve its body, comments, labels and assignees.

## Relationships

Use native GitHub sub-issues for parent/spec relationships and native issue dependencies for blocking edges. Fetch the relationship endpoints with `gh api --paginate`; preserve every blocker when scheduling.

- Blockers: `repos/jnslmk/OpenRailTransitmap/issues/<number>/dependencies/blocked_by`.
- Children: `repos/jnslmk/OpenRailTransitmap/issues/<number>/sub_issues`.
- Add a blocker with `gh api --method POST repos/jnslmk/OpenRailTransitmap/issues/<number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`; obtain the database ID with `gh api repos/jnslmk/OpenRailTransitmap/issues/<blocker-number> --jq .id`.

If native relationships are unavailable, use `Part of #<spec>` and `Blocked by: #<number>, #<number>` in issue bodies, with a child task list in the parent. A dependency is satisfied only when its blocker is closed and, for implementation batches, its change has landed.

## Pull requests as a triage surface

**PRs as a request surface: no.**
