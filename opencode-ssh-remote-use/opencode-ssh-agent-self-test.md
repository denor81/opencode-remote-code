Run an autonomous, safety-bounded self-test of the current opencode-ssh session.

This is an executable test, not a request for a plan. You must actually call the available package tools, inspect their observed results, and compare those results with the expectations below. Do not simulate tool calls and do not assign PASS without evidence.

SAFETY CONSTRAINTS

1. Call package remote_status first.
2. Do not call project tools or Task before remote_status succeeds.
3. Use only the current SSH target and the canonical remote workdir reported by remote_status.
4. Do not use local shell commands prefixed with !.
5. Do not use sudo.
6. Do not access paths outside the canonical remote workdir.
7. Do not modify existing project files.
8. Perform every mutation only inside a new directory named:
   .opencode-ssh-selftest-<UTC_TIMESTAMP>-<SHORT_RANDOM>
9. Do not reuse an existing directory.
10. Do not follow symlinks from the self-test directory.
11. Do not perform simultaneous same-path mutations.
12. Do not bypass a permission denial through another tool or agent.
13. Do not automatically retry a failed, denied, canceled, or timed-out call.
14. Every direct child must independently call package remote_status before read, write, edit, patch, or Bash operations.
15. After testing, remove only the self-test directory created by this run.
16. Before removal, prove that the canonical test path is a direct child of the canonical remote workdir and that its basename starts with `.opencode-ssh-selftest-`.
17. If the canonical workdir is `/`, remote_status identifies an unexpected target, the selected test directory already exists, or the safe test path cannot be proven, stop without mutation and report FAIL.
18. Each package Bash call starts a separate POSIX sh. Do not rely on shell variables or cd persisting between calls.
19. If a permission decision is required, wait for the operator. Do not bypass a denied or canceled decision.
20. Do not expose credentials, environment values, tokens, connection secrets, or contents outside the self-test directory.

STATUS RULES

For each ST-01 through ST-15 row, use only PASS, FAIL, or BLOCKED.

PASS requires an actual tool result matching the expected result. The only exceptions are evidence directly visible in the current model tool catalog or generated system context: ST-12 `catalog-omitted`, ST-13 `schema-omitted`, and the ST-14 disabled-resume decision. For those exceptions, record direct current-session catalog or context evidence. Unsupported prose claims are insufficient.

Use BLOCKED only when a test could not execute because of a specific earlier failed prerequisite. BLOCKED is not PASS and forces OVERALL=FAIL, but do not present it as a new independent product defect.

Within one row, status precedence is FAIL over BLOCKED over PASS. If an independent part of a row observes a real violation, assign FAIL even when another dependent part is blocked. BLOCKED is allowed only when that row contains no independent failure.

For model-filtered tools inside Evidence, use `NOT_APPLICABLE`: missing write/edit is expected when apply_patch is available and tested; missing apply_patch is expected when both write and edit are available and tested.

Assign FAIL for:

- absence of both complete mutation branches: apply_patch and write+edit;
- unexpected output or exit code;
- an automatic retry;
- the wrong remote target or workdir;
- a child without its own successful remote_status;
- a mutation outside its assigned scope;
- an unsettled process, lock, temporary artifact, or test directory;
- insufficient evidence for a required observable result.

Checks that the agent cannot technically observe must not affect PASS/FAIL. List them under NOT_COVERED.

Maintain internal results for ST-01 through ST-15. Continue after expected non-zero and timeout results when it is safe to do so.

ST-01: ROOT REMOTE STATUS

Call package remote_status exactly once during ST-01. Later explicitly required root rechecks are separate generations and do not violate this condition.

Verify:

- active=true;
- controlMaster is healthy;
- alias is non-empty;
- canonical remote workdir is absolute;
- connection ID is non-empty;
- remote hostname is non-empty;
- remote user is non-empty;
- validated identity workdir exactly equals the canonical remote workdir.

Do not call a separate Bash tool for hostname, whoami, or pwd.

Expected:

- one successful remote_status during ST-01;
- identity workdir equals canonical workdir;
- no separate Bash preflight.

Retain the canonical remote workdir as WORKDIR in the test context.

ST-02: CREATE AND ISOLATE TEST_DIR

Through package Bash with workdir=WORKDIR:

1. Generate a name `.opencode-ssh-selftest-<UTC_TIMESTAMP>-<SHORT_RANDOM>`.
2. Verify that the path does not already exist.
3. Set `umask 077`.
4. Create the directory.
5. Resolve its canonical path with `realpath -e --`.
6. Verify it is a directory and not a symlink.
7. Verify its canonical parent exactly equals WORKDIR.
8. Output the canonical test path on one line.

Create nothing else.

Retain the canonical path as TEST_DIR.

Expected:

- TEST_DIR is a direct child of WORKDIR;
- its basename starts with `.opencode-ssh-selftest-`;
- TEST_DIR is not a symlink;
- directory mode is no broader than 0700.

ST-03: BASIC REMOTE BASH

Through package Bash with workdir=TEST_DIR, execute exactly:

printf 'SELFTEST_STDOUT\n'
printf 'SELFTEST_STDERR\n' >&2
pwd -P

Verify:

- exit code 0;
- stdout contains exactly SELFTEST_STDOUT and the canonical TEST_DIR;
- stderr contains SELFTEST_STDERR;
- the command ran exactly once;
- no retry occurred.

ST-04: EXPECTED NON-ZERO RESULT

Through package Bash with workdir=TEST_DIR, execute exactly:

printf 'SELFTEST_BEFORE_FAILURE\n'
exit 7

This is an expected failed tool call. Continue the self-test afterward.

Verify:

- exit code is exactly 7;
- output contains SELFTEST_BEFORE_FAILURE;
- no automatic retry occurred.

PASS means the expected non-zero result was retained and classified correctly.

ST-05: MUTATION CATALOG, ADD, READ, AND MODE

Record the current model API ID and the mutation tools actually visible in the current tool catalog:

- write;
- edit;
- apply_patch.

Select exactly one complete mutation branch and retain it as MUTATION_BRANCH.

If both complete branches are visible, select apply_patch as the primary branch for this self-test. List visible but untested write/edit under NOT_COVERED; do not claim they passed or mark them NOT_APPLICABLE.

BRANCH A: apply_patch is available

1. Set MUTATION_BRANCH=`apply_patch`.
2. Mark missing write/edit as NOT_APPLICABLE in Evidence, not FAIL.
3. Through package apply_patch, add `TEST_DIR/mutation.txt` containing one line `before`.
4. Do not use write, edit, or Bash to create this file.

BRANCH B: apply_patch is absent, but both write and edit are available

1. Set MUTATION_BRANCH=`write+edit`.
2. Mark missing apply_patch as NOT_APPLICABLE in Evidence, not FAIL.
3. Through package write, create `TEST_DIR/mutation.txt` with exact bytes `before` and no terminal newline.
4. Do not use Bash to create this file.

If apply_patch is absent and the complete write+edit pair is absent, ST-05 FAIL. Do not substitute Bash file creation.

After the selected add operation:

1. Read mutation.txt through package read.
2. Through package Bash, verify exact bytes without shell command substitution of the file contents:
   - `wc -c` must return 6;
   - `od -An -tx1 -v` with whitespace removed must return `6265666f7265`.
3. Through package Bash, verify `stat -c '%a' --` returns mode 600.
4. Verify the file is inside TEST_DIR.

Interpret package read correctly:

- bytes `before` render as `1: before`, total 1;
- a terminal newline produces a separate empty numbered line;
- a prose summary without numbered lines and total count is not byte-exact evidence.

ST-06: SELECTED MUTATION UPDATE AND EXACT BYTES

If MUTATION_BRANCH=`apply_patch`:

1. Through a second package apply_patch, replace exactly `before` with `after` in mutation.txt.
2. Expected exact bytes after the native update: `after\n`.
3. Expected size: 6 bytes.
4. Expected hex: `61667465720a`.
5. Package read must show `1: after`, one empty line `2: `, and total 2. That one empty line represents one terminal newline and is not extra content.

If MUTATION_BRANCH=`write+edit`:

1. Through package edit, replace exactly one unique occurrence of `before` with `after` in mutation.txt.
2. Expected exact bytes: `after` without a terminal newline.
3. Expected size: 5 bytes.
4. Expected hex: `6166746572`.
5. Package read must show `1: after`, total 1.

For both branches:

1. Call package read.
2. Through package Bash, perform byte-exact `wc -c` and `od -An -tx1 -v` checks. Do not use `$(cat file)` because command substitution removes trailing newlines.
3. Verify mode remains 600.
4. Verify no other mutation occurred.

If ST-05 FAIL, ST-06 BLOCKED.

ST-07: GREP AND GLOB

Through package grep, find `after` only inside TEST_DIR using a txt include filter.

Through package glob, find txt files only inside TEST_DIR.

Expected:

- grep finds mutation.txt and the line `after`;
- glob finds mutation.txt;
- neither search returns a path outside TEST_DIR.

If ST-05 or ST-06 is not PASS, ST-07 BLOCKED.

ST-08: CREATE TIMEOUT FIXTURE THROUGH THE SELECTED MUTATION BRANCH

Create `TEST_DIR/timeout-selftest.sh` through the selected mutation branch, not through Bash.

If MUTATION_BRANCH=`apply_patch`, use package apply_patch Add File.

If MUTATION_BRANCH=`write+edit`, use package write.

Use exactly this content:

#!/bin/sh
printf 'SELFTEST_BEFORE_TIMEOUT\n'
exec tail -n 0 -f "$0"

Through package read, verify the three script lines. Through package Bash, verify the exact path is a regular file inside TEST_DIR and is not a symlink. Executable mode is not required because the script will run through sh.

If ST-05 is not PASS, ST-08 BLOCKED.

ST-09: TIMEOUT AND REMOTE PROCESS CHECK

If ST-08 is not PASS, ST-09 BLOCKED and do not start the timeout command.

Through package Bash with workdir=TEST_DIR and timeout exactly 2000 milliseconds, execute the script by substituting the exact absolute path for the placeholder and safely POSIX-shell-quoting it as one sh argument:

sh SHELL_QUOTED_EXACT_ABSOLUTE_TIMEOUT_SCRIPT_PATH

This is an expected timeout. Continue the self-test afterward.

Verify from the model-visible tool error and subsequent package-tool evidence:

- the call is classified as the expected TimeoutError or contains the unambiguous diagnostic `SSH command timed out`;
- the timeout command was invoked exactly once;
- no automatic retry occurred;
- the later exact-token process check finds no surviving process with the canonical script path.

Do not require SELFTEST_BEFORE_TIMEOUT to appear in the model-facing timeout error. On timeout, partial output is published to Bash-card metadata before the original timeout error is rethrown. Absence of the marker from the model-facing error is not ST-09 FAIL.

The agent cannot independently prove that the marker appeared and remained visible in the TUI Bash card. Record visual partial-output retention under NOT_COVERED as manual TUI evidence.

After timeout, use package Bash with workdir=TEST_DIR to inspect `/proc/[0-9]*/cmdline` for an exact argv token equal to canonical TEST_DIR/timeout-selftest.sh. The script uses `exec tail -n 0 -f "$0"`, so a surviving leaf process retains that unique path as a distinct argv token.

The checker must:

1. Derive SCRIPT dynamically from `pwd -P` and the basename. Do not place the literal absolute SCRIPT in the checker command text, or the checker could match itself.
2. Do not use `ps | grep`, `pgrep -f`, broad `pkill`, `killall`, a match only on `tail`, a substring path, or only the script basename.
3. For every candidate, read NUL-separated `/proc/PID/cmdline` and compare individual argv tokens with SCRIPT for exact equality.
4. Exclude the checker's own PID.
5. Do not pass expanded SCRIPT as an argv token to any checker helper process. Compare against the dynamic shell variable inside the checker shell; helpers used to read `/proc` must not receive SCRIPT as an argument.
6. For a matched process, record its PID and starttime from `/proc/PID/stat`.

If no process has the exact script-path argv token:

- ST-09 PASS, provided timeout classification and no-retry evidence also passed.

If a process remains:

- record PID and command;
- ST-09 FAIL;
- immediately before cleanup, revalidate the exact argv token and the same starttime;
- only when both still match, terminate that exact PID with ordinary `kill`;
- if revalidation differs, do not send a signal and record uncertainty;
- recheck process absence;
- never convert FAIL to PASS after cleanup.

ST-10: PREPARE DISJOINT CHILD SCOPES

Through package Bash, create only:

TEST_DIR/child-a
TEST_DIR/child-b

Verify both directories are empty, are directories rather than symlinks, and are inside TEST_DIR.

ST-11: TWO MUTATION CHILDREN ISSUED TOGETHER

Issue exactly two foreground direct Task calls in the same assistant turn. Do not wait for the first to settle before issuing the second. Do not use background mode.

Both children must use subagent_type=general.

Give Child A the following instruction after substituting exact absolute WORKDIR and TEST_DIR values:

"This is an opencode-ssh self-test. Expected root workdir: WORKDIR. First call package remote_status independently and verify that its validated workdir exactly equals WORKDIR. Do not call project tools before remote_status succeeds. Your only mutation scope is TEST_DIR/child-a. Do not read or modify child-b. Determine your mutation catalog independently: if apply_patch is available, use it to add only TEST_DIR/child-a/result-a.txt with exact bytes `child-a` and no terminal newline; otherwise, if write is available, create that file through write with the same exact bytes; if neither apply_patch nor write is available, return FAIL and do not use Bash for mutation. Then use package read and byte-exact package Bash `wc -c` and `od` checks to verify size 7 and hex `6368696c642d61`. Do not call Task. Return your own remote_status evidence, selected mutation tool, exact changed path, and PASS/FAIL."

Give Child B the following instruction after substituting exact absolute WORKDIR and TEST_DIR values:

"This is an opencode-ssh self-test. Expected root workdir: WORKDIR. First call package remote_status independently and verify that its validated workdir exactly equals WORKDIR. Do not call project tools before remote_status succeeds. Your only mutation scope is TEST_DIR/child-b. Do not read or modify child-a. Determine your mutation catalog independently: if apply_patch is available, use it to add only TEST_DIR/child-b/result-b.txt with exact bytes `child-b` and no terminal newline; otherwise, if write is available, create that file through write with the same exact bytes; if neither apply_patch nor write is available, return FAIL and do not use Bash for mutation. Then use package read and byte-exact package Bash `wc -c` and `od` checks to verify size 7 and hex `6368696c642d62`. Do not call Task. Return your own remote_status evidence, selected mutation tool, exact changed path, and PASS/FAIL."

The root must wait for both Task calls to settle.

After both settle:

1. Root calls remote_status again.
2. Root reads both result files through package read.
3. Root verifies that Child A and Child B each called their own remote_status.
4. Root verifies that scopes did not overlap.
5. Root verifies no grandchild was created according to available evidence.
6. Root uses package Bash to verify each result file has size 7 and the expected hex.
7. Root verifies no other file exists in child-a or child-b.

Expected:

- both Task calls were issued in one assistant turn;
- both foreground children settled;
- each child completed its own remote_status;
- result-a.txt contains exact bytes `child-a` without a terminal newline;
- result-b.txt contains exact bytes `child-b` without a terminal newline;
- each child mutated only its assigned scope;
- root waited for both.

PASS requires both Task calls to be issued in one assistant turn and both to settle. Do not claim that this proves actual temporal execution overlap: without barrier or SDK evidence, list actual overlap under NOT_COVERED. If the second Task call was issued only after the first settled, ST-11 FAIL.

ST-12: READ-ONLY EXPLORE CHILD

Launch one foreground direct child with subagent_type=explore.

Give it the following instruction after substituting exact TEST_DIR:

"First call package remote_status independently. After successful preflight, use package read, glob, or grep to verify TEST_DIR/child-a/result-a.txt and TEST_DIR/child-b/result-b.txt. Do not mutate anything. Then test the package Bash boundary: if Bash is absent from your tool catalog, record `catalog-omitted` and do not substitute another tool; if Bash is callable, invoke exactly `printf 'EXPLORE_BASH_MUST_NOT_RUN\n'` through it with workdir=TEST_DIR and expect package runtime rejection. Do not use local shell and do not bypass rejection. Do not call Task. Return your own remote_status evidence, tools used, exact values read, Bash tool result, and changes. PASS is allowed only when the read-only checks succeed and Bash is absent or actually rejected. If the marker executes, return FAIL."

Root must wait for the child.

Expected:

- child independently calls remote_status;
- read/glob/grep are available under host policy;
- both values are read correctly;
- package Bash is absent from the built-in explore catalog or the exact call is rejected;
- no Task or grandchild according to available evidence;
- no mutation.

A child's prose claim that Bash is available, without a tool result, proves neither PASS nor FAIL. If ST-11 did not create both result files, the read-only part of ST-12 is BLOCKED; still record Bash-boundary evidence separately. If explore actually executes the marker or performs mutation, ST-12 FAIL.

ST-13: BACKGROUND TASK GUARD

Inspect the model-visible Task schema.

Expected:

- if background is absent from the schema, record `schema-omitted` and assign ST-13 PASS without inventing or injecting the argument;
- if background is available in the schema, make one Task call with subagent_type=general, background=true, and no task_id; provide a harmless instruction to call only remote_status and finish;
- when the argument is available, expect package runtime rejection before any successful child result;
- record fresh foreground Task availability from ST-11 separately, but do not make it a prerequisite for this schema-guard check;
- do not retry with changed arguments.

Schema omission or actual runtime rejection is PASS. If a background child actually starts or returns a successful Task result, ST-13 FAIL.

ST-14: TASK RESUME POLICY

Determine from the current generated system context whether package Task resume is enabled.

If Task resume is disabled:

1. Do not send task_id and do not bypass the launch decision.
2. Verify generated context unambiguously says disabled.
3. Verify ST-11 established fresh foreground Task availability.

Expected:

- task_id was not sent;
- resume decision is recorded as disabled;
- fresh foreground direct children worked.

With that evidence, ST-14 PASS.

If ST-11 did not establish fresh foreground Task, still record the disabled decision, but assign ST-14 BLOCKED with prerequisite ST-11.

If Task resume is enabled:

1. Use the task_id of successfully completed Child A from ST-11 and the same subagent_type=general.
2. Call Task with that exact task_id once.
3. Give it this instruction:
   "This is a resume self-test. Your old package preflight is invalid. First call package remote_status again. Then only read your existing result-a.txt. Do not mutate anything. Return preflight and read evidence."
4. From available Task-result evidence, verify reuse of the existing child ID.
5. Verify the child completed a new remote_status.
6. Verify no mutation occurred.

With a successful resume result, new child remote_status, and no mutation, ST-14 PASS based on available agent evidence. Do not claim this independently proves exact SDK session identity.

Do not test invented, foreign-root, or cross-launch IDs in this autonomous test. If task_id is unavailable because of a specific ST-11 FAIL/BLOCKED result, assign ST-14 BLOCKED with prerequisite ST-11. Always list exact child-session identity without SDK evidence under NOT_COVERED.

ST-15: FINAL VERIFICATION AND CLEANUP

Before cleanup, root must use package read and byte-exact package Bash checks to verify:

- for MUTATION_BRANCH=`apply_patch`, mutation.txt contains exact bytes `after\n`, size 6, hex `61667465720a`;
- for MUTATION_BRANCH=`write+edit`, mutation.txt contains exact bytes `after`, size 5, hex `6166746572`;
- timeout-selftest.sh is the expected regular file;
- child-a/result-a.txt contains exact bytes `child-a`, size 7, hex `6368696c642d61`;
- child-b/result-b.txt contains exact bytes `child-b`, size 7, hex `6368696c642d62`.

Through package Bash, inspect inside TEST_DIR for:

- all files and numeric modes;
- absence of `.opencode-lock-*`;
- absence of sibling temporary artifacts;
- absence of a process with the exact timeout script path, using the same safe `/proc` exact-token method from ST-09 without helpers receiving SCRIPT as argv;
- absence of symlinks.

Record evidence before deletion.

Before cleanup:

1. Reconfirm TEST_DIR is canonical.
2. Reconfirm its canonical parent exactly equals WORKDIR.
3. Reconfirm its basename starts with `.opencode-ssh-selftest-`.
4. Reconfirm TEST_DIR is not a symlink.

Only after those checks, use package Bash to remove exactly TEST_DIR with a safely quoted exact path.

Do not use a wildcard and do not delete the parent.

Through a separate package Bash call, verify the exact TEST_DIR no longer exists.

Expected:

- all applicable expected files are correct before cleanup;
- no lock, temporary, process, or symlink artifact remains;
- only TEST_DIR was deleted;
- TEST_DIR is absent afterward;
- every observed package mutation path was inside TEST_DIR.

Cleanup is mandatory even after earlier FAIL/BLOCKED rows when exact TEST_DIR can still be proven safe. If required files are absent because of an earlier FAIL, final content verification is BLOCKED, but report cleanup PASS/FAIL separately and do not present the BLOCKED content check as a new independent filesystem defect.

If cleanup fails to remove exact TEST_DIR, leaves an identified owned process, or violates scope, ST-15 is always FAIL regardless of content status. If cleanup passes but content verification depends on an earlier failure, ST-15 is BLOCKED.

FINAL REPORT

After completion, output a Markdown table with exactly these columns:

| ID | Check | Expected | Observed | Evidence | Status |

Include ST-01 through ST-15.

Evidence must contain concise observed facts:

- tool name;
- exit code or classified error;
- bounded output;
- canonical path relative to WORKDIR;
- child preflight result;
- exact changed test paths;
- retry absence.

Do not include credentials, raw connection secrets, or unrelated project contents.

After the table, output:

TOTAL: PASS <count>; FAIL <count>; BLOCKED <count>; TOTAL 15
OVERALL: PASS | FAIL

OVERALL=PASS is allowed only when:

- all ST-01 through ST-15 rows are PASS;
- cleanup is confirmed;
- no child, process, or tool call remains unsettled;
- mutation never left TEST_DIR;
- no automatic retry occurred.

If any required test is FAIL or BLOCKED, OVERALL=FAIL. Do not count model-filtered NOT_APPLICABLE tools as FAIL or BLOCKED.

Then output:

FAILURES:
- list failed IDs and reasons;
- or `none`.

BLOCKED:
- list blocked IDs and their exact prerequisite IDs;
- or `none`.

MUTATION CATALOG:
- model API ID, when available;
- actually observed write/edit/apply_patch visibility;
- selected MUTATION_BRANCH;
- model-filtered tools marked NOT_APPLICABLE.

CHANGES:
- list only temporary test paths;
- confirm TEST_DIR was removed;
- confirm every observed package mutation path was inside TEST_DIR;
- do not claim project-wide absence of foreign or unobserved changes.

UNSETTLED:
- list unsettled child/process/tool calls;
- or `none`.

NOT_COVERED:
- visual progressive stdout/stderr updates in the Bash card;
- visual partial-output retention after failure or timeout;
- permission-dialog attribution;
- selection and process-wide behavior of external_directory Allow always;
- manual remote_status denial through the permission UI;
- human interruption through Escape;
- actual temporal Task overlap without barrier/SDK evidence;
- exact enabled-resume session identity without SDK evidence;
- independent project-wide proof of no changes outside TEST_DIR;
- universal termination of arbitrary remote descendants;
- sudo behavior;
- root workspace `/`;
- real permission UI behavior;
- default/direct-child TUI rendering.

FINAL SUMMARY:
Briefly state:

1. Whether the real SSH-backed root workflow was confirmed.
2. Whether independent child preflights were confirmed.
3. Whether disjoint child mutations were confirmed.
4. Whether file tools were confirmed.
5. Whether timeout/no-retry behavior and cleanup were confirmed.
6. Which manual UI checks remain required.

Start execution now with ST-01. Do not respond with a plan.
