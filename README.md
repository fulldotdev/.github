# fulldotdev/.github

Organization-wide GitHub configuration.

`.github/workflows/check.yml` is required on every pull request through the organization "Merge policy" ruleset. It installs with pnpm and runs the repository's `check` script. A repository without a pnpm project or a `check` script passes with a notice. Nothing needs to be added to a repository.
