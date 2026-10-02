# fulldotdev/.github

Organization-wide GitHub configuration.

`.github/workflows/check.yml` is required on every pull request through the organization "Merge policy" ruleset. It installs with pnpm and runs the repository's `check` script. A pull request fails when the base branch has `package.json`, `pnpm-lock.yaml`, and a `check` script and the pull request removes any of them. A repository whose base branch is not a pnpm project with a `check` script passes with a notice. Nothing needs to be added to a repository.

