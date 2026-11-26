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

Monorepos can give Test a `deployments` array of Netlify `context`, production `url`, repository-relative `config` and optional `base`. Preview selects targets by running each native `build.ignore` against the cumulative PR diff. Changes in `tests/`, `.github/workflows/test.yml` or the calling workflow select every target. Netlify uses the same ignore rule against its cached revision. Skipped previews are reusable only when `/.well-known/build.json` names a commit with unchanged build inputs, also one a rebase removed from the PR. Static websites may explicitly enable `production-fallback: true` for a skipped first preview; signed-in apps always require an isolated preview. `QA_DEPLOY_URLS` contains only selected targets, and repositories must exclude absent targets from their suites. An explicitly empty selection skips Web and passes Test; missing or failed selection never does.

After a push to main, Check runs source checks and unit/service tests again, Netlify runs the same build command, and Test live waits for the published revision before safe live HTTP/browser tests. Its `deployments` input lists HTTPS origins and their repository-relative Netlify config/base paths. Each build publishes `/.well-known/build.json` with its `COMMIT_REF`. For an older production deploy, Test live accepts it only if it is an ancestor of the requested revision and that site's existing Netlify `build.ignore` command confirms unchanged inputs. No Netlify token or second build is needed.

Other repositories retain their existing `check:source`, `check:build` and Test caller contracts until explicitly migrated. The reusable defaults remain compatible with them. Non-Node repositories keep their existing language-specific check command with dependency installation disabled.

Organization rules require `Check / Check` and `Review`, without requiring synchronization with main. `Review` is the last job of the PR workflow, named `Review` and calling [the review action](.github/actions/review). It needs every other job of the run and fails when one failed, was cancelled or was skipped, and on a draft, since GitHub counts a skipped required check as passed. It then waits for every `netlify-checks` preview of the PR head, so no rule names a site. A new push cancels the run and a rerun resets it. Review's `always()` keeps it running after that cancel, and the newer run waits for it in the concurrency group, so Review stops waiting once the PR's head moved on or the PR became a draft or closed. That needs `pull-requests: read` on the Review job; without it Review waits on. A workflow with `Review` has no `workflow_dispatch`: a skipped `Review` on a PR head would pass. The PR's own workflow file runs, so a PR that changes it changes its own gate; such a PR needs an independent review before it merges. Skipped URL work passes only for an explicitly empty selection. Independent agent review owns code assessment.

Jobs that mostly wait, such as Test, Test live and Review, run on Blacksmith's ARM runners in private repositories.

Live URL tests run after deployment, outside the build command. Product scenarios and fixture writes stay on previews. A repository may pass `live-test-email` and `live-test-password` only from its trusted main workflow for one ordinary login/read/sign-out smoke with its own limited account; browser recordings and signed-in artifacts stay off.

Keep repository auto-merge disabled except for content publishers and Dependabot. For CloudCannon's Publish button, a same-repository `preview` PR from `cloudcannon[bot]`, Review turns on GitHub's auto-merge with a merge commit once its checks and previews pass, and fails when GitHub refuses it; its job needs `contents: write` and `pull-requests: write`, and the repository both settings. Fulldev Sites publishes a content PR by asking GitHub to merge it once its required checks pass. Code PRs are merged by their agent.

A Shopify theme repository gets a preview theme per pull request from [the Theme preview workflow](.github/workflows/theme-preview.yml): each push to a pull request into the default branch mirrors the branch to an unpublished theme named after the pull request and the repository (`#<number> <tag> <branch>`), reports its preview link as the commit status `fulldev/theme-preview/<number>`, which Fulldev Sites shows as that version's preview, and closing the pull request or moving it to another base deletes the theme; only that pull request's theme is ever changed, also after a rebase, never a merchant's theme or another repository's preview on the same store; jobs of one pull request queue and each reads the pull request as it is when it runs. The caller runs on `pull_request_target` (opened, synchronize, reopened, edited, closed) without a branch filter, as GitHub skips `pull_request` workflows while a pull request has a merge conflict (the job only uploads a same-repository branch's files, never runs them), with `contents: read`, `pull-requests: read` and `statuses: write`, and needs the repository variable `SHOPIFY_STORE` (the store's myshopify.com address) and the secret `SHOPIFY_CLI_THEME_TOKEN`, a Theme Access password of that store. Without either it skips.

Dependabot's routine npm updates merge by themselves through [the Dependabot action](.github/actions/dependabot): websites and the Astro and Vite templates call it from a `Dependabot` workflow on `pull_request_target`, which runs the default branch's file and never checks out the PR. Each run first turns off auto-merge from an earlier run, then turns on GitHub's squash auto-merge again only when the default branch requires `Check / Check` and `Review` (without them auto-merge would merge at once, even when red), every update is a patch step or a minor step from 1.0 up, every commit is Dependabot's and signed by GitHub, and nothing under `.github/` changes. GitHub then merges once the required checks pass. Majors, minors below 1.0, pre-releases, other ecosystems and anything else stay for a person, because checks do not catch visual changes. The organization's GitHub App token (`RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`) turns it on, so the merge starts the workflows on main; without both in the repository, or without the app installed there, the job fails and nothing merges. The repository needs Allow auto-merge. Any workflow in a repository that gets the key can mint the app's tokens, so share it only with these repositories, or keep it in an environment that only `main` may use, which `pull_request_target` runs count as.

```yaml
name: Dependabot

# Dependabot's patch and minor npm updates merge by themselves once the
# required checks pass. pull_request_target runs this file from main, so a PR
# cannot change it; the action never checks out the PR.
on:
  pull_request_target:
    types: [opened, reopened, synchronize]

permissions: {}

jobs:
  auto-merge:
    name: Auto-merge
    if: ${{ github.event.pull_request.user.login == 'dependabot[bot]' }}
    runs-on: ${{ vars.CI_RUNNER || (github.event.repository.private == false && 'ubuntu-24.04') || 'blacksmith-2vcpu-ubuntu-2404-arm' }}
    timeout-minutes: 5
    steps:
      - uses: fulldotdev/.github/.github/actions/dependabot@<sha>
        with:
          app-client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}
          app-private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```
