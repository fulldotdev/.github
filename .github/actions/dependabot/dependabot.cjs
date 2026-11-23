// Dependabot auto-merge (action.yml). It runs on pull_request_target, so the
// base branch's workflow runs with the app token and the PR cannot change it.
// It turns on GitHub's auto-merge for a Dependabot npm PR with only routine
// updates; GitHub then merges it once the required checks pass. Merged with
// the app token, the push to main starts its workflows, as a person's merge
// would. Anything else stays for a person and is only noted.
const REQUIRED = ['Check / Check', 'Review'];
const ORDER = ['patch', 'minor', 'major'];

// The biggest change from one version to another: patch, minor or major.
// Below 1.0 a minor step can break, and so can any step below 0.1; a
// pre-release is never routine. All of those count as major, and so does
// anything unreadable.
function change(from, to) {
  const parse = version => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())?.slice(1).map(Number);
  const [a, b] = [parse(from), parse(to)];
  if (!a || !b) return 'major';
  if (a[0] !== b[0] || a[0] === 0 && (a[1] !== b[1] || a[1] === 0 && a[2] !== b[2])) return 'major';
  if (a[1] !== b[1]) return 'minor';
  return 'patch';
}

// Every update the commit names, with its biggest change. Security updates
// carry no update-type in their metadata, so the versions decide. Dependabot
// quotes scoped names, such as "@hono/node-server".
function updates(message) {
  const text = String(message);
  const names = [...text.matchAll(/^- dependency-name: "?([^"\s]+)"?$/gm)].map(match => match[1]);
  const steps = [
    ...text.matchAll(/^Updates `([^`]+)` from (\S+?) to (\S+?)\.?$/gm),
    ...text.matchAll(/^Bumps \[([^\]]+)\]\([^)]*\) from (\S+?) to (\S+?)\.?$/gm),
  ].map(([, name, from, to]) => ({name, from, to}));
  return names.map(name => {
    const own = steps.filter(step => step.name === name).map(step => change(step.from, step.to));
    return {name, change: own.length ? own.reduce((a, b) => ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b) : 'major'};
  });
}

module.exports = async ({github, context, core}) => {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error('Dependabot auto-merge runs on pull_request_target events only.');
  const {owner, repo} = context.repo;
  const skip = reason => core.notice(`Left for a person: ${reason}`);

  if (pull.user?.login !== 'dependabot[bot]') return skip('not a Dependabot PR.');
  if (pull.head.repo?.full_name !== `${owner}/${repo}`) return skip('the head is not in this repository.');

  // Each run decides afresh: auto-merge from an earlier run goes off first and
  // comes back only if this head still qualifies. GitHub keeps it on through
  // pushes by Dependabot and by people with write access.
  const {data: current} = await github.rest.pulls.get({owner, repo, pull_number: pull.number});
  if (current.auto_merge) {
    await github.graphql(`mutation($id: ID!) {
      disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } }
    }`, {id: pull.node_id});
  }
  if (current.state !== 'open' || current.head.sha !== pull.head.sha) return skip('the PR changed; its newer run decides.');
  if (!pull.head.ref.startsWith('dependabot/npm_and_yarn/')) return skip('only npm updates merge by themselves.');
  if (pull.base.ref !== context.payload.repository?.default_branch) return skip('it does not target the default branch.');
  if (current.draft) return skip('it is a draft.');

  // Without required checks, auto-merge would merge at once, even when red.
  const rules = (await github.rest.repos.getBranchRules({owner, repo, branch: pull.base.ref})).data;
  const required = rules.filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => rule.parameters.required_status_checks.map(check => check.context));
  const missing = REQUIRED.filter(name => !required.includes(name));
  if (missing.length) return skip(`${pull.base.ref} does not require ${missing.join(' and ')}.`);

  // Only Dependabot's own commits, which GitHub signs: anyone can set
  // Dependabot as a commit's author, and a person's push makes it their PR.
  const commits = (await github.rest.pulls.listCommits({owner, repo, pull_number: pull.number, per_page: 100})).data;
  const dependabot = commit => commit.author?.login === 'dependabot[bot]' && commit.committer?.login === 'web-flow'
    && commit.commit.verification?.verified === true;
  if (!commits.length || !commits.every(dependabot)) return skip('it has commits that are not Dependabot\'s signed commits.');
  const files = await github.paginate(github.rest.pulls.listFiles, {owner, repo, pull_number: pull.number, per_page: 100});
  if (files.some(file => file.filename.startsWith('.github/'))) return skip('it changes .github, which a person reviews.');

  const list = updates(commits.at(-1).commit.message);
  if (!list.length) return skip('its commit names no updates.');
  const majors = list.filter(update => update.change === 'major').map(update => update.name);
  if (majors.length) return skip(`a major update: ${[...new Set(majors)].join(', ')}. Checks do not catch visual changes.`);

  try {
    await github.graphql(`mutation($id: ID!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: SQUASH}) {
        pullRequest { number }
      }
    }`, {id: pull.node_id, sha: pull.head.sha});
    core.info(`Auto-merge is on for ${list.length} routine updates; GitHub merges once ${REQUIRED.join(' and ')} pass.`);
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
