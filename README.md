# fulldotdev/.github

Organization-wide GitHub defaults and reusable workflows. Repositories own their package scripts, assertions and enabled categories. These workflows own execution and time limits; they are not inherited automatically.

Callers pin a full commit SHA from `main` after the shared workflow PR is merged.

Shared Linux jobs use GitHub's `ubuntu-24.04` for public repositories and the caller's Blacksmith runner for private repositories. To switch a project, set the repository Actions variable `CI_RUNNER` to `ubuntu-24.04` or a Blacksmith Linux runner label in GitHub's Settings → Secrets and variables → Actions → Variables. Clearing it restores the default. Commands, checks and browser coverage stay the same; native macOS jobs keep their own runners. This requires callers pinned to a revision that supports `CI_RUNNER`.

New projects take their callers from [astro-template](https://github.com/fulldotdev/astro-template) or [vite-template](https://github.com/fulldotdev/vite-template).

- **Explore** experiments locally; **Implement** builds the requested change locally.
- **Draft PR** saves a coherent checkpoint or provides a shared cloud preview. Reuse the task’s PR and batch local iterations. Source checks and tests do not delay the preview.
- **Make PR ready** runs enabled checks and tests locally, then CI confirms them. Source checks and unit tests run alongside the Netlify build. URL tests use the preview of the tested PR head.
- **Merge PR** merges the validated head and follows the production build and short, safe live checks.

Fulldev, astro-template and vite-template expose `fix`, `check`, `build` and `test`. `check` validates source; `build` includes intrinsic artifact validation. Internal `test:unit`, `test:http` and `test:browser` helpers let CI run the enabled suites in the right environment. Devices stay manual. Do not add empty scripts or test workflows for disabled categories.

These callers use the Check workflow's optional `test-command` to run unit and service tests after source checks with one installation. Their Test caller disables its separate unit job. A separate Preview job waits for the selected PR revision’s deployments before Web installs dependencies or acquires its shared-account lock. Waiting does not consume the Web test budget.

Single-site callers using `preview-checks` also require `/.well-known/build.json` to identify the tested PR head. Every selected revision is checked again after Web waits for its shared-account lock.

Monorepos can give Test a `deployments` array of Netlify `context`, production `url`, repository-relative `config` and optional `base`. Preview selects targets by running each native `build.ignore` against the cumulative PR diff. Changes in `tests/` or `.github/workflows/test.yml` select every target. Netlify uses the same ignore rule against its cached revision. Skipped previews are reusable only when `/.well-known/build.json` proves an ancestor with unchanged build inputs. Static websites may explicitly enable `production-fallback: true` for a skipped first preview; signed-in apps always require an isolated preview. `QA_DEPLOY_URLS` contains only selected targets, and repositories must exclude absent targets from their suites. An explicitly empty selection skips Web and passes Test; missing or failed selection never does.

After a push to main, Check runs source checks and unit/service tests again, Netlify runs the same build command, and Test live waits for the published revision before safe live HTTP/browser tests. Its `deployments` input lists HTTPS origins and their repository-relative Netlify config/base paths. Each build publishes `/.well-known/build.json` with its `COMMIT_REF`. For an older production deploy, Test live accepts it only if it is an ancestor of the requested revision and that site's existing Netlify `build.ignore` command confirms unchanged inputs. No Netlify token or second build is needed.

Other repositories retain their existing `check:source`, `check:build` and Test caller contracts until explicitly migrated. The reusable defaults remain compatible with them. Non-Node repositories keep their existing language-specific check command with dependency installation disabled.

Repositories with `test.yml` require `Test / Test` through the existing `Review` status. Missing, failed or superseded enabled results cannot pass that gate. Skipped URL work passes only for an explicitly empty selection. Independent agent review owns code assessment; Ready has no external review-service dependency.

The Ready caller grants `actions: read` so the gate reads the current Test workflow attempt and its jobs, including reruns.

Organization rules require `Check / Check` and `Review`, without requiring synchronization with main. `Review` also requires every `netlify-checks` preview of the revision, so no rule names a site. A preview often finishes after Check, so callers without Test also run Ready on Netlify's `status` events. Live URL tests run after deployment, outside the build command. Product scenarios and fixture writes stay on previews. A repository may pass `live-test-email` and `live-test-password` only from its trusted main workflow for one ordinary login/read/sign-out smoke with its own limited account; browser recordings and signed-in artifacts stay off.

Keep repository auto-merge disabled except for content publishers. CloudCannon's Publish button keeps automatic publication for same-repository `preview` PRs created by `cloudcannon[bot]`, with all required checks and previews. Fulldev Sites publishes a content PR by asking GitHub to merge it once its required checks pass. Code PRs are merged by their agent.
