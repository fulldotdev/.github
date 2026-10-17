# fulldotdev/.github

Organization-wide GitHub defaults and reusable workflows. Repositories own their package scripts, assertions and enabled categories. These workflows own execution and time limits; they are not inherited automatically.

Callers pin a full commit SHA from `main` after the shared workflow PR is merged.

New projects take their callers from [astro-template](https://github.com/fulldotdev/astro-template) or [vite-template](https://github.com/fulldotdev/vite-template).

- **Develop** stays local while implementing and experimenting.
- **Draft PR** builds and checks artifacts locally, then opens a shared draft and Netlify preview.
- **Make PR ready** runs enabled checks and tests locally, then CI confirms them. Source checks and unit tests run alongside the Netlify build. URL tests use the preview of the tested PR head.
- **Merge PR** merges the validated head and follows the production build and short, safe live checks.

The trial callers in `fulldev`, `astro-template` and `vite-template` use `check:source` and the selected categories in `test.yml`. Devices stay manual. They pass `require-coderabbit: false` and require `Test / Test` through the existing `Review` status. Missing, skipped, failed or superseded test results cannot pass that gate. Other callers retain their existing behavior until migrated.

Organization rules require `Check / Check` and `Review`, without requiring synchronization with main. Netlify requirements are managed centrally for repositories with those sites. Production keeps scoped source, build and artifact checks. Live URL tests run after the current production deployment has been confirmed, rather than inside its build command.

Keep repository auto-merge disabled except for CloudCannon publishers. CloudCannon's Publish button keeps automatic publication for same-repository `preview` PRs created by `cloudcannon[bot]`, with all required checks and previews. Code PRs are merged by their agent.
