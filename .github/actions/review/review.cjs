// The Review check (action.yml). It runs as a job of the pull request's own
// workflow, so a new push cancels it and a rerun resets it.
module.exports = async ({github, context, core, env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now}) => {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error('Review runs on pull_request events only.');
  // A skipped required check counts as passed, so a draft fails instead.
  if (pull.draft) return core.setFailed('A draft is not reviewed. Mark the PR ready for review.');

  // So does a skipped, cancelled or failed job, and a caller that names none.
  const needs = JSON.parse(env.NEEDS || '{}');
  if (!Object.keys(needs).length) return core.setFailed('Review needs the jobs it reviews, as toJSON(needs).');
  const unfinished = Object.entries(needs).filter(([, job]) => job.result !== 'success')
    .map(([name, job]) => `${name} (${job.result})`);
  if (unfinished.length) return core.setFailed(`Did not succeed: ${unfinished.join(', ')}.`);

  // Netlify reports each preview as a commit status of the head, often after
  // the checks. A skipped preview reports success too.
  const {owner, repo} = context.repo;
  const sha = pull.head.sha;
  const previews = JSON.parse(env.NETLIFY_CHECKS || '[]');
  const minutes = Number(env.TIMEOUT_MINUTES || 15);
  const deadline = now() + minutes * 60_000;
  for (;;) {
    const {data} = await github.rest.repos.getCombinedStatusForRef({owner, repo, ref: sha, per_page: 100});
    const state = name => data.statuses.find(status => status.context === name)?.state;
    const failed = previews.filter(name => ['error', 'failure'].includes(state(name)));
    if (failed.length) return core.setFailed(`Preview failed: ${failed.join(', ')}.`);
    const waiting = previews.filter(name => state(name) !== 'success');
    if (!waiting.length) break;
    if (now() > deadline) {
      return core.setFailed(`Previews did not finish within ${minutes} minutes: ${waiting.join(', ')}. Re-run Review once they have.`);
    }
    core.info(`Waiting for ${waiting.join(', ')}`);
    await sleep(15_000);
  }

  // CloudCannon's Publish button opens a same-repository PR from `preview`;
  // GitHub merges it once the required checks pass. Without auto-merge it
  // would wait unseen, so a refusal fails Review.
  const publication = pull.user?.login === 'cloudcannon[bot]' && pull.head.ref === 'preview'
    && pull.head.repo?.full_name === `${owner}/${repo}`;
  if (!publication) return;
  // The PR may have changed while Review waited for the previews.
  const {data: current} = await github.rest.pulls.get({owner, repo, pull_number: pull.number});
  if (current.state !== 'open' || current.draft || current.head.sha !== sha || current.base.ref !== pull.base.ref) {
    return core.setFailed('The PR changed while Review waited. Re-run Review.');
  }
  if (current.auto_merge) {
    if (current.auto_merge.merge_method === 'merge') return;
    return core.setFailed(`Auto-merge is on as ${current.auto_merge.merge_method}; a publication from preview merges with a merge commit.`);
  }
  try {
    await github.graphql(`mutation($id: ID!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: MERGE}) {
        pullRequest { number }
      }
    }`, {id: pull.node_id, sha});
  } catch (error) {
    core.setFailed(`Auto-merge could not be turned on, so this publication would not merge: ${error.message}`);
  }
};
