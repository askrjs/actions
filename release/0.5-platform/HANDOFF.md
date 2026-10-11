# Nonpublishing Linux platform preparation

This is an external source proposal based on accepted Actions H
`f1d2022fafa05d09ad259c442c15758b5d5fff57`, tree
`3c400f12d3d8cf30a4d4e76ca80fc593823d6005`. It adds a tooling measurement owner;
all 28 existing Actions files, the publisher, H implementation and frozen
orchestrator v4 remain unchanged. No workflow has been emitted for execution,
no bootstrap has run, and no actual lock or Linux tool identity is approved.

The ordinary PR workflow uses Ubuntu 24.04 / Linux x86_64, system Python 3.12,
and setup-node 24.21.0. Checkout, setup-node and artifact-upload use the same
immutable official action commits as the reviewed hosted launcher v2. The
workflow has only contents/actions read permissions and no dispatch event.
Its bounded source controls run before measurement. The synthetic workflow
fixtures contain deliberately synthetic refs and are not execution authority.

## Bootstrap order without self-admission

1. Root/reviewer review this source and the exact added-file patch against H.
   Root commits the reviewed probe source as actual immutable commit S. Existing
   Actions CI continues to own existing action gates; this proposal does not
   execute v4 or qualify any release package.
2. Root prepares a separate request commit R containing a reviewed lock-seed
   config, literal tooling `package.json`, and independent source review JSON.
   The config names S, the script/package hashes, and the review asset hash.
   A separate ordinary-PR workflow successor W pins S, R and the config digest
   literally. S/R/W separation avoids a self-referential source commit.
   Templates with null fields and `approvedForMeasurement: false` reject.
3. The lock-seed job first records actual image identity, resolved Python/Git/gh
   binaries, raw full versions and hashes, Node24.21.0, bundled bootstrap npm,
   and complete Node/bundled-npm path/mode/hash projections. It uses an absent,
   UID-owned fixed anchor `/home/runner/work/_temp/askr-050-platform-probe`.
   Every command receives a constructed environment with private HOME, TMPDIR,
   npm configs/cache and gh config; no ambient token/config/bypass is copied.
   Scoped/unscoped registries both explicitly point at public npm.
4. It runs only the literal tooling dependency `npm: 12.0.1` with normal
   `npm install --package-lock-only --prefix <owned target>` using the bundled
   npm CLI under the pinned Node. The manifest has no scripts or other direct
   dependency. No installed dependency tree may exist afterward. Version/config
   reads are observations; no physical ci/install, package lifecycle, graph,
   publisher, tag or deployment step runs in this stage. Normal npm metadata
   requests/cache writes are expected. No lock is invented or self-approved.
5. Root and reviewer inspect the actual successful raw manifest/lock, S/R/W,
   Actions run/attempt/artifact ID/ZIP digest, logs, image, complete projections,
   npm archive URL and SRI. They must bind that exact generated lock and actual
   tools/platform in a NEW independent review and request commit R2. Merely
   having a successful seed receipt does not approve final tool authority.
6. A new ordinary-PR workflow successor pins S/R2/config digest and stage
   `measure`. Before any ci, it remeasures and requires byte-exact seed binary,
   version, runtime-projection and image/platform identities. Drift stops and
   needs a new reviewed seed measurement. It then runs ordinary `npm ci` using
   bundled bootstrap npm against the exact reviewed npm-only lock, with normal
   lifecycle policy and no ignore-scripts/force/legacy-peer-deps/overrides.
   It asserts the raw lock remains exact, installed name/version is npm12.0.1,
   npm/npx version is exactly12.0.1, and records the installed full runtime
   projection plus CLI hashes/config readback.
7. Root/reviewer may separately admit the measured Linux platform/tool projection
   into a future hosted launcher input. That admission, public source/workflow
   authority, real transfer/ZIP validation, state-size fit, final eighteen source
   heads/overlays and graph execution are separate pending work. Both probe
   stages report `SUCCESS_MEASUREMENT_ONLY`, `releaseQualification: false`, and
   `finalToolAuthorityApproved: false`.

## Ownership and failure evidence

The whole fixed anchor must be absent. Existing anchors, symlink input leaves
or ancestors, traversal filenames, foreign runtime symlinks, missing/null
source authority, wrong lock/version/registry/SRI and wrong tool/image identity
reject. The request bundle can contain only literal basename JSON assets selected
by raw SHA256; package content must be the exact npm-only object. Final source
checkout HEAD must equal S. Independent source review is an input whose exact
hash is approved by root and embedded into the literal workflow-config authority;
its status string alone is not a trusted external signature.

There is an 8 GiB recorded disk guard before owned bootstrap, immediately before
tooling install/ci, and at completion. Child commands use shell:false, literal
argv, a 300-second timeout and separate raw logs/command receipts. Python's
subprocess.run kills and waits for its direct child on timeout; this does not
claim a general descendant-process supervisor. This narrow tooling package is
not an arbitrary application lifecycle runner. All failure evidence and any
raw generated lock are retained. No cleanup deletes source, caches or evidence.
The workflow always uploads evidence plus npm debug logs, with unique stage /
run / attempt name, compression level0 and 90-day retention. Failures before
anchor creation remain visible in hosted step logs and missing-artifact failure;
they do not manufacture a successful measurement receipt.

Actual system tools are measured through resolved paths rather than fabricated
pins. Node/bundled-npm and installed-npm projections list regular file modes and
SHA256, and internal relative symlink mode/target hashes. They reject escaping
links. System Python/Git/gh binary hashes and complete version output do not
claim an entire system runtime filesystem projection. A normal hosted image
update can intentionally fail the subsequent exact platform comparison.

## Prepared source stages and local evidence

- `tests-only.patch` adds only the synthetic source controls. With no new owner,
  the owned test-only replay fails on missing platform_probe. This is a source
  availability RED, not an actual Linux/npm lifecycle reproduction.
- `implementation.patch` adds the probe, renderer, npm-only manifest, rejecting
  templates and this handoff. `cumulative.patch` concatenates those stages.
- The resulting 13 tiny tests exercise pure functions/mocked subprocesses only.
  Both literal synthetic workflow fixtures pass actionlint. All28 H preimages
  and accepted tree remain exact, and additions apply cleanly in an owned copy.
- The original local Python3.9 file_digest compatibility failure is preserved;
  streamed SHA256 fixed that helper. Target execution remains Python3.12 only.

No local npm/bootstrap, release-package source changes, full checks, browser,
performance sampling, graph phases, GitHub writes or dispatch occurred. Final
producer source freeze may precede Examples32 and CLI185 generated acceptance:
those are downstream consumer validations after the graph exists, not graph
construction prerequisites. Known Core all-audit development failures remain
explicit, production audit zero separately required; this probe changes no
package gates, audit policy or publication authority.
