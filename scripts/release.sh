#!/usr/bin/env bash
# Release Hermetic to the Hermes plugin catalog.
#
#   scripts/release.sh                 test, validate, push, then print the catalog entry
#                                      and the commits since the last catalog release
#   scripts/release.sh --pr            the same, then open the catalog PR from your fork
#                                      of NousResearch/hermes-agent
#   scripts/release.sh --pr --body FILE   use FILE as the PR description ({{SHA}} and
#                                      {{SHORT}} are filled in); otherwise one is written
#                                      from the commits since the last release
#   --yes                              skip the confirmation prompts
#
# If a Hermetic catalog PR of yours is still open, --pr re-pins that PR (a new commit on its
# branch and a comment listing what changed) instead of opening another one. Run it on main,
# or on a release/* branch cut from the pinned commit to keep a review fix small.
# Bump `version` in plugin.yaml and commit before running it. Needs git, node, gh (logged
# in as the repo owner) and a Hermes checkout (HERMES_AGENT, default ~/.hermes/hermes-agent).
set -euo pipefail

UPSTREAM=NousResearch/hermes-agent
ENTRY=plugin-catalog/hermetic.yaml
HERMES_AGENT=${HERMES_AGENT:-$HOME/.hermes/hermes-agent}

PR=0 YES=0 BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR=1 ;;
    --yes) YES=1 ;;
    --body) BODY=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."
die() { echo "release: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
confirm() {
  [ "$YES" = 1 ] && return 0
  local a; read -r -p "$1 [y/N] " a </dev/tty; case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}
field() { sed -n "s/^$1: *\"\{0,1\}\([^\"]*\)\"\{0,1\} *\$/\1/p" plugin.yaml | head -1; }
# plugin.yaml list -> " []" or "\n    - a\n    - b", matching the template's indentation
yaml_list() {
  local items; items=$(awk -v k="$1:" '$0==k{f=1;next} f&&/^  - /{sub(/^  - /,"");print;next} f{exit}' plugin.yaml)
  if [ -z "$items" ]; then printf ' []'; else printf '\n%s' "$(printf '%s\n' "$items" | sed 's/^/    - /')"; fi
}

command -v gh >/dev/null || die "gh is required"
[ -d "$HERMES_AGENT/scripts" ] || die "no Hermes checkout at $HERMES_AGENT (set HERMES_AGENT)"
BR=$(git branch --show-current)
case "$BR" in main|release/*) ;; *) die "run it on main or a release/* branch" ;; esac
[ -z "$(git status --porcelain)" ] || die "commit or stash your changes first"

VERSION=$(field version); REQUIRES=$(field requires_hermes)
[ -n "$VERSION" ] && [ -n "$REQUIRES" ] || die "plugin.yaml needs version and requires_hermes"

step "Catalog entry today"
LIVE=$(gh api "repos/$UPSTREAM/contents/$ENTRY" -H "Accept: application/vnd.github.raw" 2>/dev/null) || LIVE=""
OLD_SHA=$(printf '%s\n' "$LIVE" | sed -n 's/^sha: *//p')
OLD_VERSION=$(printf '%s\n' "$LIVE" | sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\}/\1/p')
if [ -n "$OLD_SHA" ]; then
  echo "hermetic $OLD_VERSION at ${OLD_SHA:0:7}"
  [ "$OLD_VERSION" != "$VERSION" ] || die "plugin.yaml is still $VERSION: bump version and commit first"
else
  echo "not listed yet: this is the first submission"
fi

step "Tests"
# quiet: show a suite's output only when it fails
run() { local out; out=$("$@" 2>&1) || { echo "$out"; die "$* failed"; }; }
run node tests/test_detect.mjs && echo "tests/test_detect.mjs passed"
for t in tests/test_*.py; do
  out=$(bash "$HERMES_AGENT/scripts/run-in-hermes-env" python3 "$t" 2>&1) || { echo "$out"; die "$t failed"; }
  echo "$t passed"
done

step "Hermes validation"
out=$(hermes plugins validate . --install-deps 2>&1) || { echo "$out"; die "validation failed"; }
printf '%s\n' "$out" | grep -A2 '^⚠' || true
printf '%s\n' "$out" | tail -1

step "Push"
git fetch -q origin "$BR" 2>/dev/null || true
if [ "$(git rev-parse HEAD)" != "$(git rev-parse -q --verify "origin/$BR" || true)" ]; then
  if git rev-parse -q --verify "origin/$BR" >/dev/null; then git log --oneline "origin/$BR..HEAD"; else git log --oneline -5; fi
  confirm "Push these commits to origin/$BR?" || die "stopped before pushing"
  git push -q origin "HEAD:$BR"
fi
SHA=$(git rev-parse HEAD); SHORT=${SHA:0:7}
echo "origin/$BR is at $SHORT"

step "New catalog entry"
OUT=$(mktemp -d "${TMPDIR:-/tmp}/hermetic-release.XXXXXX")
SHA=$SHA VERSION=$VERSION REQUIRES=$REQUIRES HOOKS=$(yaml_list provides_hooks) MIDDLEWARE=$(yaml_list provides_middleware) \
  awk 'function fill(s, k,  t, i) { t = "{{" k "}}"
         while ((i = index(s, t)) > 0) s = substr(s, 1, i - 1) ENVIRON[k] substr(s, i + length(t))
         return s }
       { n = split("SHA VERSION REQUIRES HOOKS MIDDLEWARE", ks, " "); for (j = 1; j <= n; j++) $0 = fill($0, ks[j]); print }' \
  catalog/hermetic.yaml.in > "$OUT/hermetic.yaml"
run bash "$HERMES_AGENT/scripts/run-in-hermes-env" python3 "$HERMES_AGENT/scripts/validate_plugin_catalog.py" "$OUT/hermetic.yaml"
echo "validate_plugin_catalog.py: OK"
for url in $(sed -n 's/^  - \(https:.*\)/\1/p' "$OUT/hermetic.yaml"); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = 200 ] || die "screenshot not reachable: $url"
done
if [ -n "$LIVE" ]; then diff <(printf '%s\n' "$LIVE") "$OUT/hermetic.yaml" || true; else cat "$OUT/hermetic.yaml"; fi

step "Commits in this release"
if [ -n "$OLD_SHA" ]; then git log --oneline "$OLD_SHA..$SHA"; else git log --oneline -15 "$SHA"; fi
echo; echo "Entry written to $OUT/hermetic.yaml"
[ "$PR" = 1 ] || exit 0

step "Pull request"
ME=$(gh api user --jq .login); FORK=$ME/hermes-agent
OPEN=$(gh pr list --repo "$UPSTREAM" --author "$ME" --state open --json number,headRefName \
  --jq '.[] | select(.headRefName | startswith("hermetic-")) | "\(.number) \(.headRefName)"' | head -1)
if [ -n "$OPEN" ]; then
  NUM=${OPEN%% *}; BRANCH=${OPEN#* }
  PINNED=$(gh api "repos/$FORK/contents/$ENTRY?ref=$BRANCH" -H "Accept: application/vnd.github.raw" | sed -n 's/^sha: *//p')
  [ "$PINNED" != "$SHA" ] || die "PR #$NUM already pins $SHORT"
  {
    echo "Re-pinned from ${PINNED:0:7} to $SHORT ($VERSION):"
    echo
    git log --format='- %s' "$PINNED..$SHA"
    echo
    echo "Full range: https://github.com/forefy/hermetic/compare/$PINNED...$SHA"
  } > "$OUT/comment.md"
  echo "PR #$NUM is open: it gets a new commit on $BRANCH and this comment"; echo; cat "$OUT/comment.md"; echo
  [ -z "$BODY" ] || echo "and its description is replaced with $BODY"
  confirm "Update PR #$NUM?" || die "stopped before updating the PR (entry is in $OUT)"
  EXISTING=$(gh api "repos/$FORK/contents/$ENTRY?ref=$BRANCH" --jq .sha)
  gh api -X PUT "repos/$FORK/contents/$ENTRY" -f message="plugin-catalog: pin hermetic $VERSION to $SHORT" \
    -f branch="$BRANCH" -f sha="$EXISTING" -f content="$(base64 < "$OUT/hermetic.yaml" | tr -d '\n')" >/dev/null
  if [ -n "$BODY" ]; then
    sed -e "s/{{SHA}}/$SHA/g" -e "s/{{SHORT}}/$SHORT/g" "$BODY" > "$OUT/body.md"
    gh pr edit "$NUM" --repo "$UPSTREAM" --body-file "$OUT/body.md" >/dev/null
  fi
  gh pr comment "$NUM" --repo "$UPSTREAM" --body-file "$OUT/comment.md"
  exit 0
fi
if [ -n "$OLD_SHA" ]; then TITLE="plugin-catalog: bump hermetic to $VERSION"; else TITLE="feat(plugin-catalog): add hermetic"; fi
if [ -n "$BODY" ]; then
  sed -e "s/{{SHA}}/$SHA/g" -e "s/{{SHORT}}/$SHORT/g" "$BODY" > "$OUT/body.md"
else
  {
    echo "Bumps \`$ENTRY\` from $OLD_VERSION (${OLD_SHA:0:7}) to $VERSION ($SHORT). Submitted by the repository owner."
    echo
    echo "## Changes"
    echo
    git log --format='- %s' "$OLD_SHA..$SHA"
    echo
    echo "Full range: https://github.com/forefy/hermetic/compare/$OLD_SHA...$SHA"
    echo
    echo "## Disclosures"
    echo
    echo "Unchanged from the listed version. The current list is in the README under \"What it does on your machine\"."
    echo
    echo "## Validation"
    echo
    echo "- \`hermes plugins validate . --install-deps\` at $SHORT: passed."
    echo "- \`scripts/validate_plugin_catalog.py\` on the new entry: OK."
  } > "$OUT/body.md"
fi
echo "Title: $TITLE"; echo; cat "$OUT/body.md"; echo
confirm "Open this PR on $UPSTREAM?" || die "stopped before opening the PR (entry and body are in $OUT)"

BRANCH=hermetic-$VERSION
gh repo view "$FORK" >/dev/null 2>&1 || gh repo fork "$UPSTREAM" --clone=false --default-branch-only >/dev/null
for _ in 1 2 3 4 5 6; do gh repo view "$FORK" >/dev/null 2>&1 && break; sleep 5; done
gh repo sync "$FORK" --branch main >/dev/null
BASE=$(gh api "repos/$FORK/git/ref/heads/main" --jq .object.sha)
gh api "repos/$FORK/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$BASE" >/dev/null 2>&1 ||
  gh api -X PATCH "repos/$FORK/git/refs/heads/$BRANCH" -f sha="$BASE" -F force=true >/dev/null
EXISTING=$(gh api "repos/$FORK/contents/$ENTRY?ref=$BRANCH" --jq .sha 2>/dev/null || true)
gh api -X PUT "repos/$FORK/contents/$ENTRY" -f message="$TITLE" -f branch="$BRANCH" \
  -f content="$(base64 < "$OUT/hermetic.yaml" | tr -d '\n')" ${EXISTING:+-f sha="$EXISTING"} >/dev/null
gh pr create --repo "$UPSTREAM" --base main --head "$ME:$BRANCH" --title "$TITLE" --body-file "$OUT/body.md"
