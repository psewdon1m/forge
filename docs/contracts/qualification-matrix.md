# F00 qualification matrix

Status: open. The recorded Windows results cover the development host. Installed Windows acceptance uses an isolated standard-user profile on a supported Windows build.

The controlling documentation snapshot is [general at 4449e65](https://github.com/psewdon1m-exocortex/general/tree/4449e65d732ca44b91cec5a6f3ca16c2c618578f). The verified SHA-256 of the local Part 12 bytes is `7f356b724df80444c5cd00c15bd808046f4f5667afa2cabf87cf1acd196c86a9`. Compare the immutable remote bytes and local pin before release.

| Part | Forge surface | Verification and evidence |
| --- | --- | --- |
| 00 | Policy authority and deliberate Forge visual variation | Snapshot and local Part 12 hash checked. The production plan and ADR record the owner's visual direction. Final disposition of divergences is part of F00. |
| 01 | Desktop controls, focus, Space, Site and future Settings and Documentation | Development Space evidence, keyboard entry and pointer movement in F01. Confirm responsiveness, focus and complete visual states on the supported Windows qualification profile. |
| 02 | Local diagnostics and logs | [Local diagnostics](../runbooks/diagnostics.md) includes bounded audit, rotated runtime records, retention-aware desktop pages and a sanitized ZIP. Update job logging is qualified with the updater. |
| 03 | Project data and recovery | [Project and settings backup](../runbooks/recovery.md) passed on the Windows development host, including restoration of an archived 1 GiB fixture and preferences in a separate desktop profile. [Update backup Core](update-backup-v1.md) prepares the migration scope and validates recovery staging. The signed release must demonstrate helper activation and project recovery in an isolated standard-user profile. |
| 04–05 | Native setup, authenticated distribution and desktop updater | Local setup and Windows verification workflow exist. Artifact trust, deployment topology and upgrade/rollback remain to be qualified. |
| 06 | Outgoing changes and release acceptance | Initial repository has no pushed candidate. Review all seven areas before the first push. |
| 07 | IPC, Site, project files and future outbound connections | Local sender check and [Site browser](site-profile.md) passed on the development host, including profile separation, trusted window and download approval, HTTPS policy and browser data exclusion from restored copies. Qualification on the target domain and release controls remain pending. |
| 08 | SEO/GEO | Outside product scope. Reassess if the project gains an indexable web surface. |
| 09–11 | Host agents and server deployment profiles | Outside Windows per-user profile. |
| 12 | Known problems | Immutable snapshot pin recorded. Final release must verify applicability and evidence for that exact revision. |
| 13 | Desktop dependency provenance and lifecycle | [Dependency inventory](dependencies.md) records direct components and data recipients. Review transitive and bundled components for final packaging. |

The [platform matrix](platform-matrix.md) tracks individual shell checks. The project journal under the workspace's `.history/` holds raw local evidence. Use this row format for each qualification: requirement, environment, command, fixture or candidate digest, result, evidence path, and remaining action. For release promotion, record the isolated Windows standard-user profile and identify the independently downloaded package and setup executable by their signed SHA-256 digests.
