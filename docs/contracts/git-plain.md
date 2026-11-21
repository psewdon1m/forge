# Git Plain

**Add Git** creates a card in Space. **Choose repository** opens the native folder picker. Select an existing working tree with its own .git directory. Forge remembers permission for this card and folder on this device. **Change repository** replaces that permission after a successful inspection. **Disconnect** removes the permission and leaves the repository on disk.

The card shows HEAD, the current branch, local branches, up to 40 recent commits and staged, unstaged and conflicting paths. Use **Refresh** after edits in another application. Select a staged or unstaged diff for a path, then use **Stage** or **Unstage**. Enter an author name, email and commit message to publish the current index as a local commit. The author and message are saved with the commit in the repository. Clean working trees can switch to another existing local branch. An unfinished merge or conflict blocks changes in Forge. Resolve it in your Git client and refresh. Open remote hosting with Site.

## Storage and permissions

The version 1 payload for `forge.git` is `{}`. Project ZIPs preserve the card. Its repository path and device identity live in the local desktop profile. Restoring a ZIP gives the copy a new project ID. Choose a repository again for that copy. Forge does not include the external working tree, index, or Git objects in the project ZIP. External Git mutations have their own Git history. The Space timeline can undo card changes.

The main process resolves the selected directory and verifies the identities of the working tree and .git directory on each use. Core checks that the active project still contains the Git card before reaching the repository. Its first managed profile uses the vendored libgit2 backend. It opens only the selected root, with no upward search. It requires local metadata and rejects linked worktrees, alternate object directory declarations and redirects in .git. Core replaces the repository configuration for operations and uses the local Git attributes supported by the built-in library. It does not invoke hooks, external diff tools, credential helpers or shell commands. The network and credential features are disabled.

Operations use the revision from the reviewed Git state. Core checks the index, HEAD, local branches and metadata of pending working-tree files. An external index writer can hold the normal index lock and block a Forge write. Stage and unstage prepare a copy of the index and publish through that lock. Commits hold HEAD, branch and index locks while publishing a local reference. Safe branch checkout preserves uncommitted files, refuses an ignored-path collision, and checks the target tree for supported regular files and directories. Checkout or filesystem failure can require further review with the user's Git client. Forge does not force a checkout to repair it.

Diffs are informational. A patch is limited to 128 KiB of text and files larger than 1 MiB are represented as binary. The first profile supports paths representable in UTF-8 and up to 1,000 local branches and 5,000 pending paths. Forge shows the reason when a repository is outside the supported profile.

## Qualification

Run `cargo test --locked -p forge-core --test git`. On Windows, build the desktop and Core and run `node tests/git-desktop.mjs`. The test uses a synthetic Git working tree. It checks picker permission, staged and unstaged text, stale revisions, local commit and clean checkout, external filter and hook isolation, conflict preservation, reopening with the same profile and re-binding after a project ZIP restore.
