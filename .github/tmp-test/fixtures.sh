#!/bin/bash
# Usage per scenario: base files spec, PR action. Runs the extracted step as GitHub would (bash -e).
set -u
SCRIPT=$PWD/find-check.sh
root=$(mktemp -d /tmp/sec-report/work/fx.XXXX)
PKG_CHECK='{"name":"x","scripts":{"check":"prettier --check ."}}'
PKG_NOCHECK='{"name":"x","scripts":{"build":"astro build"}}'
scenario() {
  local name=$1 base=$2 pr=$3 expect=$4
  local d=$root/$name; mkdir -p "$d"; cd "$d"
  git init -q -b main; git config user.email t@t; git config user.name t
  echo readme > README.md
  case $base in
    pnpm) echo "$PKG_CHECK" > package.json; echo "lockfileVersion: '9.0'" > pnpm-lock.yaml;;
    nocheck) echo "$PKG_NOCHECK" > package.json; echo "lockfileVersion: '9.0'" > pnpm-lock.yaml;;
    nolock) echo "$PKG_CHECK" > package.json;;
    none) ;;
  esac
  git add -A; git commit -qm base
  git checkout -qb pr
  case $pr in
    readme) echo more >> README.md;;
    rmlock) git rm -q pnpm-lock.yaml;;
    rmpkg) git rm -q package.json;;
    rmcheck) echo "$PKG_NOCHECK" > package.json;;
    badjson) echo "{not json" > package.json;;
    rmall) git rm -q package.json pnpm-lock.yaml;;
    addpnpm) echo "$PKG_CHECK" > package.json; echo "lockfileVersion: '9.0'" > pnpm-lock.yaml;;
    addpartial) echo "$PKG_CHECK" > package.json;;
    addcheck) echo "$PKG_CHECK" > package.json;;
  esac
  git add -A; git commit -qm pr
  # Move main forward like a real base branch, then build the merge commit GitHub would.
  git checkout -q main; echo base2 > other.txt; git add -A; git commit -qm base2
  if [ "$expect" = "nomerge" ]; then git checkout -q pr; else git checkout -q --detach main; git merge -q --no-ff --no-edit pr; fi
  out=$(mktemp); : > "$out"
  log=$(GITHUB_OUTPUT=$out GITHUB_BASE_REF=main bash -e "$SCRIPT" 2>&1); code=$?
  run=$(grep -c '^run=true$' "$out")
  if [ $code -ne 0 ]; then result=fail; elif [ "$run" = 1 ]; then result=run; else result=skip; fi
  [ "$expect" = nomerge ] && expect=fail
  status=$([ "$result" = "$expect" ] && echo PASS || echo MISMATCH)
  printf '%-9s %-28s base=%-8s pr=%-10s expect=%-4s got=%-4s exit=%s\n    %s\n' "$status" "$name" "$base" "$pr" "$expect" "$result" "$code" "$log"
}
scenario pnpm-readme            pnpm    readme     run
scenario pnpm-remove-lockfile   pnpm    rmlock     fail
scenario pnpm-remove-package    pnpm    rmpkg      fail
scenario pnpm-remove-check      pnpm    rmcheck    fail
scenario pnpm-broken-json       pnpm    badjson    fail
scenario pnpm-remove-all        pnpm    rmall      fail
scenario exempt-none-readme     none    readme     skip
scenario exempt-none-addpnpm    none    addpnpm    run
scenario exempt-none-partial    none    addpartial skip
scenario exempt-nocheck-readme  nocheck readme     skip
scenario exempt-nocheck-rmlock  nocheck rmlock     skip
scenario exempt-nocheck-addchk  nocheck addcheck   run
scenario exempt-nolock-readme   nolock  readme     skip
scenario not-a-merge-commit     pnpm    readme     nomerge
rm -rf "$root"
