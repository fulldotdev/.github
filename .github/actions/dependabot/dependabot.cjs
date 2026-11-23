// Dependabot auto-merge (action.yml). It runs on pull_request_target, so the
// base branch's workflow runs with the app token and the PR cannot change it.
// It turns on GitHub's auto-merge for a Dependabot npm PR with only patch and
// minor updates; GitHub then merges it once the required checks pass. Merged
// with the app token, the push to main starts its workflows, as a person's
// merge would. Anything else stays for a person and is only noted.
const REQUIRED = ['Check / Check', 'Review'];

// The biggest change from one version to another: patch, minor or major.
// Below 1.0 a minor step can break, and a pre-release is never routine, so
// both count as major. Anything unreadable counts as major too.
function change(from, to) {
  const parse = version => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())?.slice(1).map(Number);
  const [a, b] = [parse(from), parse(to)];
  if (!a || !b) return 'major';
  if (a[0] !== b[0] || a[0] === 0 && (a[1] !== b[1] || a[1] === 0 && a[2] !== b[2])) return 'major';
  if (a[1] !== b[1]) return 'minor';
  return 'patch';
}

// Every update the commit names, with its versions. Security updates carry
// no update-type in their metadata, so the versions decide.
function updates(message) {
  const names = [...String(message).matchAll(/^- dependency-name: (\S+)$/gm)].map(match => match[1]);
  const steps = [
    ...String(message).matchAll(/^Updates `([^`]+)` from (\S+?) to (\S+?)\.?$/gm),
    ...String(message).matchAll(/^Bumps \[([^\]]+)\]\([^)]*\) from (\S+?) to (\S+?)\.?$/gm),
  ].map(([, name, from, to]) => ({name, from, to}));
  return names.map(name => {
    const own = steps.filter(step => step.name === name);
    return {name, change: own.length ? own.map(step => change(step.from, step.to))
      .reduce((a, b) => ['patch', 'minor', 'major'].indexOf(a) >= ['patch', 'minor', 'major'].indexOf(b) ? a : b) : 'major'};
  });
}

module.exports = async ({github, context, core}) => {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error('Dependabot auto-merge runs on pull_request_target events only.');
  const {owner, repo} = context.repo;
  const skip = reason => core.notice(`Left for a person: ${reason}`);

  if (pull.user?.login !== 'dependabot[bot]') return skip('not a Dependabot PR.');
  if (pull.head.repo?.full_name !== `${owner}/${repo}`) return skip('the head is not in this repository.');

  // A Dependabot PR that no longer qualifies, say after a person's push or a
  // rebase onto a major, loses the auto-merge an earlier run turned on.
  const {data: current} = await github.rest.pulls.get({owner, repo, pull_number: pull.number});
  if (current.state !== 'open' || current.head.sha !== pull.head.sha) return skip('the PR changed; its newer run decides.');
  const stop = async reason => {
    if (current.auto_merge) {
      await github.graphql(`mutation($id: ID!) {
        disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } }
      }`, {id: pull.node_id});
      reason += ' Auto-merge is off again.';
    }
    skip(reason);
  };

  if (!pull.head.ref.startsWith('dependabot/npm_and_yarn/')) return stop('only npm updates merge by themselves.');
  if (pull.base.ref !== context.payload.repository?.default_branch) return stop('it does not target the default branch.');
  if (current.draft) return stop('it is a draft.');

  // Without required checks, auto-merge would merge at once, even when red.
  const rules = (await github.rest.repos.getBranchRules({owner, repo, branch: pull.base.ref})).data;
  const required = rules.filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => rule.parameters.required_status_checks.map(check => check.context));
  const missing = REQUIRED.filter(name => !required.includes(name));
  if (missing.length) return stop(`${pull.base.ref} does not require ${missing.join(' and ')}.`);

  // Only Dependabot's own commits: a person's push makes it a person's PR.
  const commits = (await github.rest.pulls.listCommits({owner, repo, pull_number: pull.number, per_page: 100})).data;
  if (!commits.length || commits.some(commit => commit.author?.login !== 'dependabot[bot]')) {
    return stop('it has commits from someone other than Dependabot.');
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {owner, repo, pull_number: pull.number, per_page: 100});
  if (files.some(file => file.filename.startsWith('.github/'))) return stop('it changes .github, which a person reviews.');

  const list = updates(commits.at(-1).commit.message);
  if (!list.length) return stop('its commit names no updates.');
  const majors = list.filter(update => update.change === 'major').map(update => update.name);
  if (majors.length) return stop(`a major update: ${[...new Set(majors)].join(', ')}. Checks do not catch visual changes.`);

  if (current.auto_merge) return core.info(`Auto-merge is already on as ${current.auto_merge.merge_method}.`);
  try {
    await github.graphql(`mutation($id: ID!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: SQUASH}) {
        pullRequest { number }
      }
    }`, {id: pull.node_id, sha: pull.head.sha});
    core.info(`Auto-merge is on for ${list.length} patch and minor updates; GitHub merges once ${REQUIRED.join(' and ')} pass.`);
  } catch (error) {
    // GitHub refuses auto-merge when the PR can already merge.
    if (!/clean status/i.test(error.message)) {
      return core.setFailed(`Auto-merge could not be turned on: ${error.message}`);
    }
    await github.rest.pulls.merge({owner, repo, pull_number: pull.number, sha: pull.head.sha, merge_method: 'squash'});
    core.info('The required checks had passed, so it merged now.');
  }
};

module.exports.change = change;
module.exports.updates = updates;
