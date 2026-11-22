# fulldotdev/.github

Organization-wide GitHub defaults and reusable workflows. Repositories own their package scripts, assertions and enabled categories. These workflows own execution and time limits; they are not inherited automatically.

Callers pin a full commit SHA from `main` after the shared workflow PR is merged.

Shared Linux jobs use GitHub's `ubuntu-24.04` for public repositories and the caller's Blacksmith runner for private repositories. To switch a project, set the repository Actions variable `CI_RUNNER` to `ubuntu-24.04` or a Blacksmith Linux runner label in GitHub's Settings → Secrets and variables → Actions → Variables. Clearing it restores the default. Commands, checks and browser coverage stay the same; native macOS jobs keep their own runners. This requires callers pinned to a revision that supports `CI_RUNNER`.

New projects take their callers from [astro-template](https://github.com/fulldotdev/astro-template) or [vite-template](https://github.com/fulldotdev/vite-template).

- **Working** builds and checks the change locally.
- **Pull request** pushes the finished, reviewed work as a PR ready for review; every push runs CI, and drafts skip the tests. Source checks and unit tests run alongside the Netlify build. URL tests use the preview of the tested PR head.
- **Merge** merges the validated head and follows the production build and short, safe live checks.

Fulldev, astro-template and vite-template expose `fix`, `check`, `build` and `test`. `check` validates source; `build` includes intrinsic artifact validation. Internal `test:unit`, `test:http` and `test:browser` helpers let CI run the enabled suites in the right environment. Devices stay manual. Do not add empty scripts or test workflows for disabled categories.

These callers use the Check workflow's optional `test-command` to run unit and service tests after source checks with one installation. Their Test caller disables its separate unit job. Check, Test and Review are jobs of one workflow per PR, with Test alongside Check. A separate Preview job waits for the selected PR revision’s deployments before Web installs dependencies or acquires its shared-account lock. Waiting does not consume the Web test budget.

Single-site callers using `preview-checks` also require `/.well-known/build.json` to identify the tested PR head. Every selected revision is checked again after Web waits for its shared-account lock.

Monorepos can give Test a `deployments` array of Netlify `context`, production `url`, repository-relative `config` and optional `base`. Preview selects targets by running each native `build.ignore` against the cumulative PR diff. Changes in `tests/`, `.github/workflows/test.yml` or the calling workflow select every target. Netlify uses the same ignore rule against its cached revision. Skipped previews are reusable only when `/.well-known/build.json` proves an ancestor with unchanged build inputs. Static websites may explicitly enable `production-fallback: true` for a skipped first preview; signed-in apps always require an isolated preview. `QA_DEPLOY_URLS` contains only selected targets, and repositories must exclude absent targets from their suites. An explicitly empty selection skips Web and passes Test; missing or failed selection never does.

After a push to main, Check runs source checks and unit/service tests again, Netlify runs the same build command, and Test live waits for the published revision before safe live HTTP/browser tests. Its `deployments` input lists HTTPS origins and their repository-relative Netlify config/base paths. Each build publishes `/.well-known/build.json` with its `COMMIT_REF`. For an older production deploy, Test live accepts it only if it is an ancestor of the requested revision and that site's existing Netlify `build.ignore` command confirms unchanged inputs. No Netlify token or second build is needed.

Other repositories retain their existing `check:source`, `check:build` and Test caller contracts until explicitly migrated. The reusable defaults remain compatible with them. Non-Node repositories keep their existing language-specific check command with dependency installation disabled.

Organization rules require `Check / Check` and `Review`, without requiring synchronization with main. `Review` is the last job of the PR workflow, named `Review` and calling [the review action](.github/actions/review). It needs every other job of the run and fails when one failed, was cancelled or was skipped, since GitHub counts a skipped required check as passed. It then waits for every `netlify-checks` preview of the PR head, so no rule names a site. A new push cancels the run and a rerun resets it. A workflow with `Review` has no `workflow_dispatch`: a skipped `Review` on a PR head would pass. Skipped URL work passes only for an explicitly empty selection. Independent agent review owns code assessment.

Jobs that mostly wait, such as Test, Test live and Review, run on Blacksmith's ARM runners in private repositories.

Live URL tests run after deployment, outside the build command. Product scenarios and fixture writes stay on previews. A repository may pass `live-test-email` and `live-test-password` only from its trusted main workflow for one ordinary login/read/sign-out smoke with its own limited account; browser recordings and signed-in artifacts stay off.

Keep repository auto-merge disabled except for content publishers. For CloudCannon's Publish button, a same-repository `preview` PR from `cloudcannon[bot]`, Review turns on GitHub's auto-merge once its checks and previews pass. A repository whose releases run on a push to main passes a GitHub App token as `merge-token`, because a merge by `GITHUB_TOKEN` starts no workflows. Fulldev Sites publishes a content PR by asking GitHub to merge it once its required checks pass. Code PRs are merged by their agent.
