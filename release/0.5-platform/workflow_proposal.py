"""External renderer only. No GitHub access or workflow writes."""
import re

CHECKOUT = "3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP_NODE = "949feb2413d6458794dcd2491c4babbbce0c15c1"
UPLOAD = "cf430e030ddbb5b0abf93d22962f4752f3646cd9"


def render(source_commit, request_commit, config_sha256, stage):
    if not all(isinstance(x, str) and re.fullmatch(r"[0-9a-f]{40}", x) for x in [source_commit, request_commit]):
        raise ValueError("actual immutable source and measurement-config commits required")
    if not isinstance(config_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", config_sha256):
        raise ValueError("actual reviewed measurement-config digest required")
    if stage not in ["lock-seed", "measure"]:
        raise ValueError("one literal measurement stage required")
    return f'''name: Nonpublishing Linux platform {stage}
on:
  pull_request:
    branches: [main]
    paths: ["release/0.5-platform/**", "release/0.5-platform-request/**", ".github/workflows/platform-probe.yml"]
permissions:
  contents: read
  actions: read
concurrency:
  group: askr-050-platform-measurement
  cancel-in-progress: false
jobs:
  platform:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@{CHECKOUT}
        with:
          repository: askrjs/actions
          ref: {source_commit}
          path: probe
          persist-credentials: false
      - uses: actions/checkout@{CHECKOUT}
        with:
          repository: askrjs/actions
          ref: {request_commit}
          path: request
          persist-credentials: false
      - name: Bounded source controls only
        shell: bash
        run: python3 -B -m unittest discover -s probe/release/0.5-platform -p test_platform_probe.py -v
      - uses: actions/setup-node@{SETUP_NODE}
        with:
          node-version: 24.21.0
          package-manager-cache: false
      - name: One reviewed tooling-only measurement
        shell: bash
        run: >-
          python3 probe/release/0.5-platform/platform_probe.py
          --stage {stage}
          --config request/release/0.5-platform-request/config.json
          --config-sha256 {config_sha256}
          --bundle request/release/0.5-platform-request/bundle
      - name: Preserve raw platform/tool/lock/config evidence
        if: always()
        uses: actions/upload-artifact@{UPLOAD}
        with:
          name: askr-050-platform-{stage}-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}
          path: |
            ${{{{ runner.temp }}}}/askr-050-platform-probe/evidence/
            ${{{{ runner.temp }}}}/askr-050-platform-probe/npm-cache/_logs/
          if-no-files-found: error
          compression-level: 0
          retention-days: 90
'''
