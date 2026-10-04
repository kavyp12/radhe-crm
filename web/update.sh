#!/usr/bin/env bash
# Updates the live CRM on the server (D71, docs/DEPLOY.md §9). Run as the app user:
#   ~/app/web/update.sh            → the latest main from GitHub
#   ~/app/web/update.sh <commit>   → that commit instead (roll back to an earlier release)
# fetch → install → back up the database → migrate → build → restart the app.
# ponytail: builds in place, so the site is down while it builds (a few minutes) and stays down after a failed build
# until a roll back; build into a second folder and switch if that ever matters. Update outside office hours.
set -Eeuo pipefail

main() {
  cd "$(dirname "$0")"
  export PATH="$HOME/node/bin:$PATH"
  local from
  from=$(git rev-parse --short HEAD)
  trap 'echo "✗ Update stopped (see above). If the site is down, roll back: $0 $from" >&2' ERR

  git fetch --quiet origin
  git checkout --quiet --detach "${1:-origin/main}"
  echo "Updating $from → $(git rev-parse --short HEAD)"
  pnpm install --frozen-lockfile
  pnpm db:backup # just before the migrations: a release can be undone with this dump (docs/DEPLOY.md §9)
  pnpm db:migrate
  # ponytail: one retry for next.js#99114 (Google Fonts sometimes answers in a form Next 16.3.6 can't read, and the
  # build cache keeps it); drop it once Next ships the fix or Roboto is self-hosted.
  pnpm build || { rm -rf .next/cache && pnpm build; }
  sudo systemctl restart radhe-crm
  sleep 5
  systemctl is-active --quiet radhe-crm # still up: the start-up check of web/.env passed
  echo "✓ Running $(git rev-parse --short HEAD). Roll back with: $0 $from"
}

# The whole file is read before it runs: git may rewrite it on the way.
main "$@"; exit
