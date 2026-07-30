# JSON and API patterns

The `gh api` command is useful for accessing data not available through other
subcommands.

Get PR with specific fields:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

Most commands support `--json` and `--jq` for structured filtering:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```

Use API patterns when:

- standard `gh pr`, `gh issue`, or `gh run` output is not enough
- you need review comment IDs for in-thread replies
- you need GraphQL-only relationships such as parent/sub-issues
