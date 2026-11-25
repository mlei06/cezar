---
description: Did the task use time and tokens in proportion to its size?
labels:
  - { value: lean, score: 1.0, description: no notable waste for the size of the job }
  - { value: some-waste, score: 0.6, description: noticeable but limited waste }
  - { value: wasteful, score: 0, description: waste that dominated the run's time or tokens }
passingScore: 0.6
samplingRate: 100
---
Use the metrics (requests, context per call, model time against tool time, largest outputs) and the transcript together. Waste looks like:
- printing whole large files or docs when a search or a line range would do (large early outputs inflate every later call's context);
- waiting on a build, deploy or job by checking back turn after turn instead of one waiting command;
- writing new scripts or tooling for something that already exists in the repo or the brief;
- repeating a failing command without changing anything;
- writing a file and then patching it again and again;
- doing work outside the brief;
- using a large model for work that needs little reasoning.

Anchor the label to these:
- `wasteful` when two or more of the patterns above are substantial (for example a first read over 30k characters that inflates every later call, plus repeated polling), or when the average context per request is over 100k tokens on a job that didn't need it.
- `some-waste` when one pattern is substantial, or several are small.
- `lean` only when nothing above is notable.

Judge against the size of the job: a big migration may legitimately take many calls, but its context still shouldn't be inflated by reads it never needed. Quote the calls or metrics that show the waste.
