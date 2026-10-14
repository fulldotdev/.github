# fulldotdev/.github

Organization-wide GitHub defaults and reusable workflows. Repository callers select their own check command; workflows here are not inherited automatically.

Callers pin a full commit SHA from `main` after the shared workflow PR is merged.

New projects take their callers from [astro-template](https://github.com/fulldotdev/astro-template) or [vite-template](https://github.com/fulldotdev/vite-template).

- **Finalize (Prepare)** leaves a complete draft PR. Previews build; full checks wait for Ready.
- **Dispatch (Release)** validates the affected behavior and marks the PR Ready, authorizing automatic merge once the required checks and previews pass. Choose `review-ready` before marking Ready when CodeRabbit approval is needed.
- **Settle (Close)** follows production verification and preserves the result before closing the task.

Organization rules require `Check / Check` and `Review`, without requiring synchronization with main. Netlify requirements are managed centrally for the repositories with those sites. Production keeps its scoped check and build. A skipped or outdated CodeRabbit review cannot satisfy a selected review.
