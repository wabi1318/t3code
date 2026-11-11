#!/bin/bash
set -euo pipefail

if [[ $# -ne 0 || $(uname -s) != Darwin ]]; then
  echo 'Usage (macOS): vp run app-sync' >&2
  exit 1
fi

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
destination='/Applications/T3 Code (Beta).app'
backup_root="$HOME/Library/Application Support/T3-local-build-backups"
lock_dir="$repo_dir/release/.install-local-desktop.lock"
stage_dir=''
backup_dir=''

mkdir -p "$repo_dir/release"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another install may be running. Lock: $lock_dir" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$backup_dir" && -d "$backup_dir/T3 Code (Beta).app" && ! -e "$destination" ]]; then
    mv "$backup_dir/T3 Code (Beta).app" "$destination"
  fi
  [[ -z "$stage_dir" ]] || rm -rf "$stage_dir"
  rmdir "$lock_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo_dir"
case $(uname -m) in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'Unsupported macOS architecture.' >&2; exit 1 ;;
esac
version=$(node -p "JSON.parse(require('node:fs').readFileSync('apps/desktop/package.json', 'utf8')).version")
T3CODE_DESKTOP_UPDATE_REPOSITORY='' GITHUB_REPOSITORY='' \
  vp run dist:desktop:artifact --platform mac --target dir --arch "$arch" \
  --output-dir "$repo_dir/release/local-desktop" --build-version "$version"

if [[ "$arch" == arm64 ]]; then
  source_app="$repo_dir/release/local-desktop/mac-arm64/T3 Code (Beta).app"
else
  source_app="$repo_dir/release/local-desktop/mac/T3 Code (Beta).app"
fi
[[ -f "$source_app/Contents/Info.plist" ]]
[[ ! -f "$source_app/Contents/Resources/app-update.yml" ]]
stage_dir=$(mktemp -d '/Applications/.t3-local-install.XXXXXX')
ditto "$source_app" "$stage_dir/T3 Code (Beta).app"
mkdir -p "$backup_root"
backup_dir=$(mktemp -d "$backup_root/$(date +%Y%m%d-%H%M%S).XXXXXX")
if [[ -e "$destination" ]]; then
  mv "$destination" "$backup_dir/T3 Code (Beta).app"
fi
mv "$stage_dir/T3 Code (Beta).app" "$destination"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
if [[ -e "$backup_dir/T3 Code (Beta).app" || -L "$backup_dir/T3 Code (Beta).app" ]]; then
  if [[ -x /usr/bin/trash ]]; then
    /usr/bin/trash -s "$backup_dir/T3 Code (Beta).app"
  else
    /usr/bin/osascript -l JavaScript - "$backup_dir/T3 Code (Beta).app" <<'JXA'
ObjC.import('Foundation');
function run(args) {
  const error = Ref();
  const previousApp = $.NSURL.fileURLWithPath(args[0]);
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(previousApp, null, error)) {
    throw new Error(ObjC.unwrap(error[0].localizedDescription));
  }
}
JXA
  fi
fi
rmdir "$backup_dir"
backup_dir=''
echo "Installed: $destination"
echo 'Previous version moved to Trash if present.'
echo 'Quit and reopen T3 Code to use this build. The running app was not restarted.'
