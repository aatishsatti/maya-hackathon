#!/bin/sh
# Maya pre-push check. THIS IS AN EXAMPLE: nothing installs it for you, and it never runs unless you copy it yourself:
#
#     cp scripts/pre-push.example.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
#
# It runs the checks that need no network and no keys: the offline tests, then the offline part of the evaluation (the trends simulation,
# compared with docs/eval/baseline.json). It stops the push if either fails.
#
# It does NOT run the Meta evaluation (`npm run eval`): that makes about 700 real Meta calls. Run that yourself before a release, or after
# changing a prompt, a threshold or anything that decides what Maya says.
set -e
cd "$(git rev-parse --show-toplevel)"
echo "pre-push: offline tests..."
npm test --silent
echo "pre-push: offline evaluation (trends simulation vs the saved baseline)..."
node eval/run.js --suites trends
echo "pre-push: ok"
