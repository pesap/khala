# Issues

Create an issue with labels:

```bash
gh issue create --repo owner/repo \
  --title "feat: my feature" \
  --label "enhancement" \
  --label "priority:high" \
  --body "Description here"
```

## Issue labels

Inspect current labels before changing state:

```bash
gh issue view 123 --repo owner/repo --json labels \
  --jq '.labels[].name'
```

Apply a ready-for-agent state by adding the ready label and removing mutually
exclusive non-ready labels:

```bash
gh issue edit 123 --repo owner/repo \
  --add-label "workon-ready" \
  --add-label "enhancement" \
  --remove-label "additional-info-needed" \
  --remove-label "ready-for-human" \
  --remove-label "split-needed" \
  --remove-label "declined" \
  --remove-label "duplicate"
```

Route an issue that needs reporter clarification:

```bash
gh issue edit 123 --repo owner/repo \
  --add-label "additional-info-needed" \
  --remove-label "workon-ready" \
  --remove-label "ready-for-agent" \
  --remove-label "ready-for-human"
```

Create missing labels explicitly instead of assuming they already exist:

```bash
gh label create "workon-ready" --repo owner/repo \
  --description "Canonical issue body is ready for autonomous pickup"

gh label create "additional-info-needed" --repo owner/repo \
  --description "Triage needs concrete missing information before implementation"
```

Verify labels after mutation:

```bash
gh issue view 123 --repo owner/repo --json labels \
  --jq '.labels[].name'
```

## Native sub-issues (parent/child)

GitHub has built-in parent/child relationships. Use GraphQL API.

Query sub-issues:

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    issue(number: 176) {
      subIssues(first: 10) {
        nodes { number title }
      }
    }
  }
}'
```

Query parent:

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    issue(number: 177) {
      parent { number title }
    }
  }
}'
```

Get node IDs (required for mutations):

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    parent: issue(number: 176) { id }
    child: issue(number: 177) { id }
  }
}'
```

Add sub-issue:

```bash
gh api graphql -f query='
mutation {
  addSubIssue(input: {
    issueId: "PARENT_NODE_ID",
    subIssueId: "CHILD_NODE_ID"
  }) {
    issue { number }
    subIssue { number }
  }
}'
```

Remove sub-issue:

```bash
gh api graphql -f query='
mutation {
  removeSubIssue(input: {
    issueId: "PARENT_NODE_ID",
    subIssueId: "CHILD_NODE_ID"
  }) {
    issue { number }
    subIssue { number }
  }
}'
```

## Native issue dependencies

GitHub exposes native `blockedBy` and `blocking` relationships through GraphQL.
Query them separately from `gh issue view --json`:

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    issue(number: 176) {
      blockedBy(first: 10) {
        nodes { number title state url }
      }
      blocking(first: 10) {
        nodes { number title state url }
      }
      issueDependenciesSummary {
        blockedBy
        blocking
        totalBlockedBy
        totalBlocking
      }
    }
  }
}'
```
