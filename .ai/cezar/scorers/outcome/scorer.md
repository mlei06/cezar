---
description: Did the task deliver what its brief asked?
labels:
  - { value: delivered, score: 1.0, description: met every done criterion the brief states or clearly implies }
  - { value: partial, score: 0.5, description: met some criteria, left some undone, or needed a person to finish }
  - { value: missed, score: 0, description: did not deliver, delivered the wrong thing, or claimed success the transcript doesn't support }
passingScore: 1.0
samplingRate: 100
---
Judge only against the brief (the task text) and what the transcript shows was done.

- List the brief's done criteria for yourself first. If the brief names none, use its plain intent.
- A claim in the final message counts only if the transcript shows it happening (a command and its output, a PR URL, a test result).
- Stopping with a clear, correct explanation of a real blocker the agent could not resolve is `partial`, not `missed`.
- Asking the owner something the brief or the environment already answered makes it `partial` at best.
