#!/bin/bash
# Block until the poller logs a manager reply or a task end state (or the timeout), then print new lines.
DATA=$(python3 -c 'import json,os;print(os.path.expanduser(json.load(open(os.path.expanduser("~/.config/factory-overseer.json")))["dataDir"]))')
L=$DATA/events.log
MARK=$DATA/.last-line
n=$(cat "$MARK" 2>/dev/null || wc -l < "$L")
timeout=${1:-1800}
end=$((SECONDS+timeout))
while [ $SECONDS -lt $end ]; do
  if tail -n +$((n+1)) "$L" | grep -qE "\] assistant|\] (done|failed|cancelled|review) wf=|user: |unreachable"; then sleep 20; break; fi
  sleep 15
done
tail -n +$((n+1)) "$L" | cut -c1-1200
wc -l < "$L" > "$MARK"
