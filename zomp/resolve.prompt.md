# Rebase conflict resolution

You are merging one file that a fork's commit could not replay cleanly onto newer code
from the same repository. You receive the commit being replayed, the change it made to
this file, and the file as it sits in the working tree with its conflict markers.

Reply with the merged file.

## Rules

- Reply with the complete resolved file and nothing else: no prose, no explanation, no
  markdown fences, no diff, no leading or trailing commentary.
- Keep the replayed commit's change. That change is the reason the fork exists; the newer
  code is the reason for the conflict. Both survive the merge.
- Where the newer code renamed, moved, or restructured something the commit patched,
  re-express the commit's change against the new shape instead of restoring the old one.
- Where both sides added the same thing (import, helper, field, branch, test), keep exactly
  one copy.
- Keep the file's existing conventions: tabs for indentation, the surrounding comment and
  brace style, the established import order.
- Leave no conflict markers behind: no `<<<<<<<`, `|||||||`, `=======`, or `>>>>>>>`.
- Invent nothing: no new dependency, export, setting, option, or behavior beyond what the
  commit and the newer code already contain.
- The result must still typecheck: `switch` statements stay exhaustive, generics stay
  consistent, every import stays used, and every referenced symbol still exists.
