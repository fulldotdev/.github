# fulldotdev/.github

Organization-wide GitHub defaults and reusable workflows. Repositories own their package scripts, assertions and enabled categories. These workflows own execution and time limits; they are not inherited automatically.

Callers pin a full commit SHA from `main` after the shared workflow PR is merged.

New projects take their callers from [astro-template](https://github.com/fulldotdev/astro-template) or [vite-template](https://github.com/fulldotdev/vite-template).

- **Explore** experiments locally; **Implement** builds the requested change locally.
- **Draft PR** builds locally, then opens a shared draft and a Netlify preview. Source checks and tests do not delay the preview.
- **Make PR ready** runs enabled checks and tests locally, then CI confirms them. Source checks and unit tests run alongside the Netlify build. URL tests use the preview of the tested PR head.
- **Merge PR** merges the validated head and follows the production build and short, safe live checks.

Fulldev, astro-template and vite-template expose `fix`, `check`, `build` and `test`. `check` validates source; `build` includes intrinsic artifact validation. Internal `test:unit`, `test:http` and `test:browser` helpers let CI run the enabled suites in the right environment. Devices stay manual. Do not add empty scripts or test workflows for disabled categories.

These callers use the Check workflow's optional `test-command` to run unit and service tests after source checks with one installation. Their Test caller disables its separate unit job. Browser dependencies install before waiting for the exact PR revision's previews.

After a push to main, Check runs source checks and unit/service tests again, Netlify runs the same build command, and Test live waits for the published revision before safe live HTTP/browser tests. Its `deployments` input lists HTTPS origins and their repository-relative Netlify config/base paths. Each build publishes `/.well-known/build.json` with its `COMMIT_REF`. For an older production deploy, Test live accepts it only if it is an ancestor of the requested revision and that site's existing Netlify `build.ignore` command confirms unchanged inputs. No Netlify token or second build is needed.

Other repositories retain their existing `check:source`, `check:build` and Test caller contracts until explicitly migrated. The reusable defaults remain compatible with them. Non-Node repositories keep their existing language-specific check command with dependency installation disabled.

Repositories with `test.yml` require `Test / Test` through the existing `Review` status. Missing, skipped, failed or superseded test results cannot pass that gate. Independent agent review owns code assessment; Ready has no external review-service dependency.

The Ready caller grants `actions: read` so the gate reads the current Test workflow attempt and its jobs, including reruns.

Organization rules require `Check / Check` and `Review`, without requiring synchronization with main. Netlify requirements are managed centrally for repositories with those sites. Live URL tests run after deployment, outside the build command; signed-in tests and writes stay on previews.

Keep repository auto-merge disabled except for CloudCannon publishers. CloudCannon's Publish button keeps automatic publication for same-repository `preview` PRs created by `cloudcannon[bot]`, with all required checks and previews. Code PRs are merged by their agent.
