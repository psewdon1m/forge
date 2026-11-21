# ADR 0002 — Forge policy profile

Status: development profile recorded. Publication requirements are scheduled for F06–F08.

Repository is `psewdon1m/forge`, default branch `main`. Forge runs per user on Windows with a local project directory. The development test fixture binds only to loopback and qualification hooks require a development launch. The runtime provides no inbound application API. Site is read-only to the host and uses an independent browser profile. The external model provider planned for F09 is optional and must use explicit user-authorized context. Internal Exocortex integrations and public SEO/GEO are outside the project scope.

The release profile will require a scoped trust anchor, signed version manifest, per-user replacement helper and verified backup/update/rollback. The repository identity is verified. Remote write access, the protected publishing environment and signing trust remain release qualifications. [Production plan](../../.docs/Forge_Production_Plan_v0.1.md)
