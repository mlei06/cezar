---
description: Did the task stay inside its brief?
labels:
  - { value: in-scope, score: 1.0, description: did what was asked and no more }
  - { value: drifted, score: 0.5, description: added unrequested work of modest size, or redefined part of the task }
  - { value: out-of-scope, score: 0, description: substantial unrequested work, a different task, or decisions reserved for the owner }
passingScore: 1.0
samplingRate: 100
---
- Necessary supporting work (a test for the change, a small fix the change needs) is in scope.
- Building new systems, rewriting requirements, or expanding the deliverable is drift.
- Reporting a missing piece of scope instead of doing it is correct behaviour, not drift.
