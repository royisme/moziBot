# Contributing to Mozi

Thank you for your interest in contributing to Mozi!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feature/your-feature`

## Development Setup

```bash
# Install Node.js + pnpm (Corepack recommended)
corepack enable
corepack prepare pnpm@10.28.1 --activate

# Clone and setup
git clone https://github.com/yourusername/mozi.git
cd mozi
pnpm install

# Run in development mode
pnpm run dev
```

## Code Quality

Before submitting a PR:

```bash
pnpm run check    # Linting and type checking
pnpm run test     # Run tests
pnpm run format   # Format code
```

All checks must pass.

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Formatting, no code change
- `refactor:` - Code restructuring
- `test:` - Adding tests
- `chore:` - Maintenance tasks

Examples:

```
feat: add Discord channel support
fix: container timeout not respected
docs: update installation guide
```

## Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all checks pass
4. Write a clear PR description
5. Reference any related issues

## Philosophy: Features vs Skills

**Don't add features to the core. Add skills instead.**

If you want to add a new capability (e.g., GitHub integration), consider:

1. Can it be a skill? → Create a skill package
2. Does it need core changes? → Discuss in an issue first

This keeps the core minimal while enabling extensibility.

## What We Accept

✅ Accepted:

- Bug fixes
- Security improvements
- Performance optimizations
- Documentation improvements
- Test coverage improvements
- Skills and extensions (as separate packages)

⚠️ Discuss First:

- New core features
- Breaking changes
- Major refactors
- New dependencies

❌ Generally Not Accepted:

- Features that could be skills
- Opinionated workflow changes
- Large dependency additions

## Questions?

- Open a GitHub issue for bugs/features
- Start a discussion for questions
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
