#!/usr/bin/env bash
# Publish packaging/PKGBUILD to the AUR as zomp-git, by hand, from this machine.
#
#   packaging/aur-publish.sh            # refresh, show the diff, push
#   packaging/aur-publish.sh --dry-run  # refresh and show the diff only
#
# The AUR checkout lives in ~/.cache/zomp-aur/zomp-git. pkgver in the AUR copy
# is a snapshot of origin/main (makepkg recomputes it at build time anyway).
set -euo pipefail

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
work="${XDG_CACHE_HOME:-$HOME/.cache}/zomp-aur/zomp-git"
aur_url="ssh://aur@aur.archlinux.org/zomp-git.git"

command -v makepkg >/dev/null || { echo "makepkg not found (needs pacman)" >&2; exit 1; }

# The AUR builds from GitHub, so publish what GitHub has, not local work.
git -C "$repo" fetch -q origin main
if [ "$(git -C "$repo" rev-parse HEAD)" != "$(git -C "$repo" rev-parse origin/main)" ]; then
    echo "note: local HEAD differs from origin/main; publishing origin/main's PKGBUILD" >&2
fi
sha="$(git -C "$repo" rev-parse --short=9 origin/main)"

# Same format as pkgver() in the PKGBUILD; only upstream's v* tags count.
if desc="$(git -C "$repo" describe --tags --long --abbrev=7 --match 'v*' origin/main 2>/dev/null)"; then
    ver="$(printf '%s' "$desc" | sed 's/-\([0-9]\+\)-g/.r\1.g/')"
else
    ver="r$(git -C "$repo" rev-list --count origin/main).g$(git -C "$repo" rev-parse --short=7 origin/main)"
fi

if [ ! -d "$work/.git" ]; then
    mkdir -p "$(dirname "$work")"
    git clone -q "$aur_url" "$work" 2>/dev/null || { git init -q -b master "$work"; git -C "$work" remote add origin "$aur_url"; }
else
    git -C "$work" pull -q --ff-only origin master 2>/dev/null || true
fi

git -C "$repo" show origin/main:packaging/PKGBUILD >"$work/PKGBUILD"
sed -i "s/^pkgver=.*/pkgver=$ver/" "$work/PKGBUILD"
(cd "$work" && makepkg --printsrcinfo >.SRCINFO)

cd "$work"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet && git rev-parse -q --verify HEAD >/dev/null; then
    echo "AUR zomp-git is already up to date ($ver)"
    exit 0
fi
git diff --cached --stat
if [ "$dry" = 1 ]; then
    git reset -q
    echo "dry run: would publish zomp-git $ver from $sha"
    exit 0
fi
git commit -qm "zomp-git $ver (from $sha)"
git push -q origin HEAD:master
echo "published zomp-git $ver: https://aur.archlinux.org/packages/zomp-git"
