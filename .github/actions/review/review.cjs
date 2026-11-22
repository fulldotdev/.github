// The Review check (action.yml). It runs as a job of the pull request's own
// workflow, so a new push cancels it and a rerun resets it.
module.exports = async ({github, context, core, env, fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now}) => {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error('Review runs on pull_request events only.');

  // A skipped required check counts as passed, so a skipped, cancelled or
  // failed job fails Review.
  const needs = JSON.parse(env.NEEDS || '{}');
  const unfinished = Object.entries(needs).filter(([, job]) => job.result !== 'success')
    .map(([name, job]) => `${name} (${job.result})`);
  if (unfinished.length) return core.setFailed(`Did not succeed: ${unfinished.join(', ')}.`);

  // Netlify reports each preview as a commit status of the head, often after
  // the checks. A skipped preview reports success too.
  const {owner, repo} = context.repo;
  const sha = pull.head.sha;
  const previews = JSON.parse(env.NETLIFY_CHECKS || '[]');
  const deadline = now() + Number(env.TIMEOUT_MINUTES || 15) * 60_000;
  for (;;) {
    const {data} = await github.rest.repos.getCombinedStatusForRef({owner, repo, ref: sha, per_page: 100});
    const state = name => data.statuses.find(status => status.context === name)?.state;
    const failed = previews.filter(name => ['error', 'failure'].includes(state(name)));
    if (failed.length) return core.setFailed(`Preview failed: ${failed.join(', ')}.`);
    const waiting = previews.filter(name => state(name) !== 'success');
    if (!waiting.length) break;
    if (now() > deadline) {
      return core.setFailed(`Previews did not finish within ${env.TIMEOUT_MINUTES || 15} minutes: ${waiting.join(', ')}. Re-run Review once they have.`);
    }
    core.info(`Waiting for ${waiting.join(', ')}`);
    await sleep(15_000);
  }

  // CloudCannon's Publish button opens a same-repository PR from `preview`.
  const publication = pull.user?.login === 'cloudcannon[bot]' && pull.head.ref === 'preview'
    && pull.head.repo?.full_name === `${owner}/${repo}`;
  if (!publication) return;
  const response = await fetch(env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql', {
    method: 'POST',
    headers: {Authorization: `Bearer ${env.MERGE_TOKEN}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query: `mutation($id: ID!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: MERGE}) {
        pullRequest { number }
      }
    }`, variables: {id: pull.node_id, sha}}),
  });
  const result = await response.json().catch(() => ({}));
  // The checks passed, so a person can still merge it.
  if (!response.ok || result.errors) {
    core.error(`Auto-merge could not be turned on: ${result.errors?.[0]?.message ?? response.status}`);
  }
};
