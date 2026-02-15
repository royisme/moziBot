---
name: github-integration
description: Interact with GitHub using gh CLI for issues, PRs, workflows, and repository management.
---

# GitHub Integration

Use this skill to interact with GitHub repositories via the `gh` CLI tool.

## Prerequisites

Ensure `gh` CLI is installed and authenticated:
```bash
gh auth status
```

If not authenticated:
```bash
gh auth login
```

## When To Use

- "create an issue for this bug"
- "open a PR with these changes"
- "check the CI status"
- "list recent commits"
- "review open PRs"
- "create a release"

## Common Commands

### Issues
```bash
# List open issues
gh issue list

# View specific issue
gh issue view 123

# Create new issue
gh issue create --title "Bug: login fails" --body "Steps to reproduce..."

# Close issue
gh issue close 123
```

### Pull Requests
```bash
# List open PRs
gh pr list

# View PR details
gh pr view 456

# Create PR from current branch
gh pr create --title "Add feature X" --body "This PR implements..."

# Check out a PR locally
gh pr checkout 456

# Merge PR
gh pr merge 456 --squash

# Review PR
gh pr review 456 --approve
```

### Repository
```bash
# View repository info
gh repo view

# List recent commits
gh log --oneline -10

# View workflow runs
gh run list

# View specific workflow
gh run view 789

# Create release
gh release create v1.2.3 --title "Version 1.2.3" --notes "Changes..."
```

### Workflows & Actions
```bash
# List workflow runs
gh run list

# View failed run logs
gh run view 789 --log-failed

# Rerun failed jobs
gh run rerun 789
```

## Best Practices

1. **Always** check current branch before creating PR
2. **Include** descriptive titles and bodies
3. **Link** related issues ("Fixes #123")
4. **Review** changes before merging
5. **Clean up** branches after merging

## Example Workflows

### Feature Development
```bash
# 1. Create branch
git checkout -b feature/new-feature

# 2. Make changes...
# ... edit files ...

# 3. Commit
git add . && git commit -m "Add new feature"

# 4. Push
git push origin feature/new-feature

# 5. Create PR
gh pr create --title "Add new feature" --body "Implements #456"
```

### Bug Fix
```bash
# Create issue first
gh issue create --title "Bug: ..." --label "bug"

# Fix code...

# Create PR that closes the issue
gh pr create --title "Fix: ..." --body "Closes #123"
```
