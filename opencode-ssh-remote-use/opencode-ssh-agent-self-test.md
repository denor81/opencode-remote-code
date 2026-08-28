# OpenCode SSH Agent Self-Test Prompt

Use this prompt only on a disposable, non-production SSH target and remote
workdir. Start `opencode-ssh <alias> <absolute-remote-workdir>`, then paste the
entire prompt below into the opened root session.

The prompt tests only behavior the agent can observe through package tools. It
must report visual permission/TUI behavior and human cancellation as not
covered rather than claiming a pass.

```text
Проведи автономный безопасный self-test текущей сессии opencode-ssh.

Это исполняемая проверка, а не описание плана. Ты обязан реально вызывать доступные package tools, проверять фактические результаты и сравнивать их с ожидаемыми значениями. Не симулируй tool calls и не ставь PASS без наблюдаемого evidence.

ОГРАНИЧЕНИЯ БЕЗОПАСНОСТИ

1. Сначала вызови package remote_status.
2. До успешного remote_status не вызывай project tools и Task.
3. Используй только текущий SSH target и canonical remote workdir из remote_status.
4. Не используй локальные shell-команды с префиксом !.
5. Не используй sudo.
6. Не обращайся к путям вне canonical remote workdir.
7. Не изменяй существующие project-файлы.
8. Все изменения выполняй только внутри нового каталога с именем:
   .opencode-ssh-selftest-<UTC_TIMESTAMP>-<SHORT_RANDOM>
9. Не используй уже существующий каталог.
10. Не следуй symlink из self-test каталога.
11. Не выполняй simultaneous same-path mutations.
12. Не обходи permission deny через другой tool или agent.
13. Не повторяй автоматически failed, denied, canceled или timed-out вызов.
14. Каждый direct child обязан самостоятельно вызвать package remote_status до read/write/bash.
15. После проверки удали только созданный self-test каталог.
16. Перед удалением проверь, что canonical test path является прямым потомком remote workdir и basename начинается с `.opencode-ssh-selftest-`.
17. Если canonical workdir равен `/`, remote_status не совпадает с ожидаемым target, test directory уже существует или безопасный test path нельзя подтвердить, прекрати проверку без mutation и выдай FAIL.
18. Помни, что каждый package bash запускается в отдельном POSIX sh. Не рассчитывай на сохранение shell variables или cd между вызовами.
19. Если требуется permission confirmation, дождись решения оператора. Denied или canceled operation не обходи.
20. Не показывай credentials, environment, tokens, connection secrets или содержимое файлов вне self-test каталога.

СТАТУСЫ

Для каждой строки ST-01...ST-15 используй только PASS, FAIL или BLOCKED.

PASS разрешён только при наличии фактического tool result, совпадающего с
ожидаемым результатом. Исключения явно ограничены текущим model-visible catalog
или generated system context: ST-12 `catalog-omitted`, ST-13 `schema-omitted` и
ST-14 disabled decision. Для этих исключений зафиксируй direct current-session
catalog/context evidence; одного неподкреплённого prose-утверждения недостаточно.

BLOCKED используй только когда проверка не могла выполниться из-за конкретной
предыдущей failed-проверки. BLOCKED не является PASS и приводит к OVERALL=FAIL,
но не выдавай его за новый независимый product defect.

Внутри одной строки приоритет статусов: FAIL выше BLOCKED, BLOCKED выше PASS.
Если независимая часть строки обнаружила реальное нарушение, ставь FAIL даже
при заблокированной зависимой части. BLOCKED допустим только при отсутствии
самостоятельного failure в этой строке.

Для отдельных model-filtered tools внутри Evidence используй
`NOT_APPLICABLE`: отсутствие `write`/`edit` нормально, когда фактически
доступен и проверяется `apply_patch`; отсутствие `apply_patch` нормально,
когда фактически доступны и проверяются `write` вместе с `edit`.

FAIL ставится при:
- отсутствии обеих полных mutation-веток: `apply_patch` и `write+edit`;
- unexpected output или exit code;
- автоматическом retry;
- неправильном remote target/workdir;
- child без собственного remote_status;
- mutation вне назначенного scope;
- оставшемся process, lock, temporary artifact или test directory;
- невозможности получить достаточное evidence.

Проверки, которые агент технически не способен наблюдать, не включай в PASS/FAIL итог. Перечисли их отдельно в NOT_COVERED.

Веди внутренний список результатов ST-01...ST-15 и продолжай после ожидаемых non-zero/timeout результатов, если это безопасно.

ST-01: ROOT REMOTE STATUS

Вызови package remote_status ровно один раз в рамках ST-01. Более поздние явно
предписанные root rechecks считаются отдельными поколениями и не нарушают ST-01.

Проверь:
- active=true;
- controlMaster healthy;
- alias непустой;
- canonical remote workdir абсолютный;
- connection ID непустой;
- remote hostname непустой;
- remote user непустой;
- validated identity workdir точно совпадает с canonical remote workdir.

Не вызывай отдельный bash для hostname, whoami или pwd.

Ожидается:
- один успешный remote_status;
- identity workdir совпадает с canonical workdir;
- отдельного Bash preflight нет.

Сохрани canonical remote workdir как WORKDIR в контексте проверки.

ST-02: СОЗДАНИЕ И ИЗОЛЯЦИЯ TEST DIRECTORY

Через package bash с workdir=WORKDIR:

1. Сгенерируй имя `.opencode-ssh-selftest-<UTC_TIMESTAMP>-<SHORT_RANDOM>`.
2. Убедись, что такого пути ещё нет.
3. Выполни `umask 077`.
4. Создай каталог.
5. Получи его canonical path через `realpath -e --`.
6. Проверь, что это directory, не symlink.
7. Проверь, что parent canonical path точно равен WORKDIR.
8. Выведи canonical test path одной строкой.

Не создавай ничего другого.

Сохрани canonical path как TEST_DIR.

Ожидается:
- TEST_DIR является прямым потомком WORKDIR;
- basename начинается с `.opencode-ssh-selftest-`;
- TEST_DIR не является symlink;
- directory mode не шире 0700.

ST-03: BASIC REMOTE BASH

Через package bash с workdir=TEST_DIR выполни ровно:

printf 'SELFTEST_STDOUT\n'
printf 'SELFTEST_STDERR\n' >&2
pwd -P

Проверь:
- exit code 0;
- stdout содержит ровно `SELFTEST_STDOUT` и canonical TEST_DIR;
- stderr содержит `SELFTEST_STDERR`;
- команда выполнилась ровно один раз;
- retry отсутствовал.

ST-04: EXPECTED NON-ZERO RESULT

Через package bash с workdir=TEST_DIR выполни ровно:

printf 'SELFTEST_BEFORE_FAILURE\n'
exit 7

Это ожидаемый failed tool call. После него продолжи self-test.

Проверь:
- exit code точно 7;
- output содержит `SELFTEST_BEFORE_FAILURE`;
- автоматического retry не было.

PASS означает, что ожидаемый non-zero был корректно сохранён и распознан.

ST-05: MUTATION CATALOG, ADD, READ И MODE

Зафиксируй текущий model API ID и фактически доступные mutation tools:

- write;
- edit;
- apply_patch.

Выбери ровно одну полную mutation-ветку и сохрани её как MUTATION_BRANCH.
Если одновременно видны обе полные ветки, выбери apply_patch как основную для
этого self-test, а видимые, но не проверенные write/edit перечисли в NOT_COVERED;
не объявляй их PASS или NOT_APPLICABLE.

ВЕТКА A: если доступен apply_patch

1. Установи MUTATION_BRANCH=`apply_patch`.
2. Отсутствующие write/edit отметь в Evidence как NOT_APPLICABLE, не FAIL.
3. Через package apply_patch добавь `TEST_DIR/mutation.txt` с одной строкой `before`.
4. Не используй write, edit или bash для создания этого файла.

ВЕТКА B: только если apply_patch отсутствует, но доступны и write, и edit

1. Установи MUTATION_BRANCH=`write+edit`.
2. Отсутствующий apply_patch отметь в Evidence как NOT_APPLICABLE, не FAIL.
3. Через package write создай `TEST_DIR/mutation.txt` с точными bytes `before` без terminal newline.
4. Не используй bash для создания этого файла.

Если apply_patch отсутствует и полная пара write+edit отсутствует, ST-05 FAIL.
Не подменяй проверку созданием файла через bash.

После выбранной add-операции:

1. Через package read прочитай mutation.txt.
2. Через package bash проверь exact bytes без command substitution текста:
   - `wc -c` должен вернуть 6;
   - `od -An -tx1 -v` после удаления whitespace должен вернуть `6265666f7265`.
3. Через package bash проверь `stat -c '%a' --`; ожидается mode 600.
4. Проверь, что файл находится внутри TEST_DIR.

Интерпретация package read:

- bytes `before` отображаются как `1: before`, total 1;
- terminal newline создаёт отдельную пустую нумерованную строку;
- prose-пересказ без numbered lines и total count не является byte-exact evidence.

ST-06: SELECTED MUTATION UPDATE И EXACT BYTES

Если MUTATION_BRANCH=`apply_patch`:

1. Вторым package apply_patch замени в mutation.txt ровно `before` на `after`.
2. Ожидаемые exact bytes после native update: `after\n`.
3. Ожидаемый размер: 6 bytes.
4. Ожидаемый hex: `61667465720a`.
5. Package read должен показать `1: after`, одну пустую строку `2: ` и total 2. Эта одна пустая строка означает один terminal newline и не является лишним содержимым.

Если MUTATION_BRANCH=`write+edit`:

1. Через package edit замени в mutation.txt ровно одно уникальное вхождение `before` на `after`.
2. Ожидаемые exact bytes: `after` без terminal newline.
3. Ожидаемый размер: 5 bytes.
4. Ожидаемый hex: `6166746572`.
5. Package read должен показать `1: after`, total 1.

Для обеих веток:

1. Выполни package read.
2. Через package bash выполни byte-exact проверку `wc -c` и `od -An -tx1 -v`; не используй `$(cat file)`, потому что command substitution удаляет trailing newlines.
3. Проверь сохранение mode 600.
4. Проверь отсутствие других изменений.

Если ST-05 FAIL, ST-06 BLOCKED.

ST-07: GREP И GLOB

Через package grep найди строку `after` только внутри TEST_DIR с include для txt-файлов.

Через package glob найди txt-файлы только внутри TEST_DIR.

Ожидается:
- grep находит `mutation.txt` и строку `after`;
- glob находит `mutation.txt`;
- поиск не возвращает пути вне TEST_DIR.

Если ST-05 или ST-06 не PASS, ST-07 BLOCKED.

ST-08: CREATE TIMEOUT FIXTURE THROUGH SELECTED MUTATION BRANCH

Создай `TEST_DIR/timeout-selftest.sh` через выбранную mutation-ветку, не через bash.

Если MUTATION_BRANCH=`apply_patch`, используй package apply_patch Add File.

Если MUTATION_BRANCH=`write+edit`, используй package write.

с точным содержимым:

#!/bin/sh
printf 'SELFTEST_BEFORE_TIMEOUT\n'
exec tail -n 0 -f "$0"

Через package read проверь три строки script. Через package bash проверь, что
exact path является regular file внутри TEST_DIR и не symlink. Executable mode
не требуется, потому что script будет запущен через `sh`.

Если ST-05 не PASS, ST-08 BLOCKED.

ST-09: TIMEOUT И REMOTE PROCESS CHECK

Если ST-08 не PASS, ST-09 BLOCKED и не запускай timeout-команду.

Через package bash с workdir=TEST_DIR и timeout ровно 2000 миллисекунд выполни,
подставив exact absolute path вместо placeholder и безопасно shell-quoted его
как один аргумент `sh`:

sh SHELL_QUOTED_EXACT_ABSOLUTE_TIMEOUT_SCRIPT_PATH

Это ожидаемый timeout. После него продолжи self-test.

Проверь:
- partial output содержит `SELFTEST_BEFORE_TIMEOUT`;
- результат классифицирован как timeout;
- автоматического retry не было.

После timeout через package bash с workdir=TEST_DIR проверь `/proc/[0-9]*/cmdline`
на exact argv token, равный canonical TEST_DIR/timeout-selftest.sh. Script
использует `exec tail -n 0 -f "$0"`, поэтому surviving leaf process сохраняет
этот unique path отдельным argv token.

Checker обязан:

1. Получить SCRIPT динамически из `pwd -P` и basename; не помещать literal
   absolute SCRIPT в текст checker-команды, иначе checker может совпасть сам с
   собой.
2. Не использовать `ps | grep`, `pgrep -f`, broad `pkill`, `killall`, совпадение
   только по имени `tail`, substring path или только basename.
3. Для каждого candidate читать NUL-separated `/proc/PID/cmdline` и сравнивать
   отдельные argv tokens с SCRIPT на exact equality.
4. Исключить собственный PID checker.
5. Не передавать expanded SCRIPT как argv token ни одному helper process
   checker-а. Сравнение с динамической shell variable выполняй внутри checker
   shell; helpers для чтения `/proc` не должны получать SCRIPT аргументом.
6. Для найденного process записать PID и starttime из `/proc/PID/stat`.

Если process с точным script path отсутствует:
- ST-09 PASS.

Если process остался:
- зафиксируй PID и command;
- ST-09 FAIL;
- непосредственно перед cleanup повторно проверь exact argv token и тот же
  starttime; только при обоих совпадениях заверши этот PID обычным `kill`;
- если revalidation не совпала, не отправляй signal и запиши uncertainty;
- повторно проверь отсутствие процесса;
- не превращай FAIL в PASS после cleanup.

ST-10: ПОДГОТОВКА DISJOINT CHILD SCOPES

Через package bash создай только:

TEST_DIR/child-a
TEST_DIR/child-b

Проверь, что оба каталога пусты, являются directories, не symlinks и находятся внутри TEST_DIR.

ST-11: ДВА ПАРАЛЛЕЛЬНЫХ MUTATION CHILDREN

Запусти ровно два foreground direct Task-вызова параллельно в одном assistant turn. Не запускай второй после завершения первого. Background не используй.

Оба child должны иметь subagent_type=general.

Передай Child A эту инструкцию, подставив точные абсолютные WORKDIR и TEST_DIR:

"Это self-test opencode-ssh. Ожидаемый root workdir: WORKDIR. Сначала самостоятельно вызови package remote_status и проверь, что validated workdir точно совпадает с WORKDIR. До успешного remote_status не вызывай project tools. Твой единственный mutation scope: TEST_DIR/child-a. Не читай и не изменяй child-b. Самостоятельно определи mutation catalog: если доступен apply_patch, добавь через него только TEST_DIR/child-a/result-a.txt с exact bytes `child-a` без terminal newline; иначе, если доступен write, создай этот файл через write с теми же exact bytes; если нет ни apply_patch, ни write, верни FAIL и не используй bash для mutation. Затем через package read и byte-exact package bash `wc -c`/`od` проверь размер 7 и hex `6368696c642d61`. Не вызывай Task. Верни own remote_status evidence, выбранный mutation tool, exact changed path и PASS/FAIL."

Передай Child B эту инструкцию, подставив точные абсолютные WORKDIR и TEST_DIR:

"Это self-test opencode-ssh. Ожидаемый root workdir: WORKDIR. Сначала самостоятельно вызови package remote_status и проверь, что validated workdir точно совпадает с WORKDIR. До успешного remote_status не вызывай project tools. Твой единственный mutation scope: TEST_DIR/child-b. Не читай и не изменяй child-a. Самостоятельно определи mutation catalog: если доступен apply_patch, добавь через него только TEST_DIR/child-b/result-b.txt с exact bytes `child-b` без terminal newline; иначе, если доступен write, создай этот файл через write с теми же exact bytes; если нет ни apply_patch, ни write, верни FAIL и не используй bash для mutation. Затем через package read и byte-exact package bash `wc -c`/`od` проверь размер 7 и hex `6368696c642d62`. Не вызывай Task. Верни own remote_status evidence, выбранный mutation tool, exact changed path и PASS/FAIL."

Root обязан дождаться обоих Task-вызовов.

После завершения:
1. Root повторно вызывает remote_status.
2. Root через package read проверяет оба result-файла.
3. Root проверяет, что Child A и Child B вызвали собственный remote_status.
4. Root проверяет, что scopes не пересечены.
5. Root проверяет, что не создан grandchild.
6. Root через package bash проверяет exact bytes result-файлов: размер 7 и соответствующий hex.
7. Root проверяет отсутствие других файлов в child-a и child-b.

Ожидается:
- оба Task-вызова были инициированы параллельно;
- оба foreground children завершились;
- каждый child выполнил собственный remote_status;
- result-a.txt содержит exact bytes `child-a` без terminal newline;
- result-b.txt содержит exact bytes `child-b` без terminal newline;
- каждый child изменил только свой scope;
- root дождался обоих.

PASS требует, чтобы оба Task-вызова были выданы в одном assistant turn и оба
settled. Не утверждай, что это доказывает реальное временное overlap исполнения:
без barrier/SDK evidence actual overlap включи в NOT_COVERED. Если второй Task
был выдан только после settlement первого, ST-11 FAIL.

ST-12: READ-ONLY EXPLORE CHILD

Запусти один foreground direct child с subagent_type=explore.

Передай ему эту инструкцию с точным TEST_DIR:

"Сначала самостоятельно вызови package remote_status. После успешного preflight используй package read, glob или grep, чтобы проверить TEST_DIR/child-a/result-a.txt и TEST_DIR/child-b/result-b.txt. Ничего не изменяй. Затем проверь package Bash boundary: если bash отсутствует в твоём tool catalog, зафиксируй `catalog-omitted` и не подменяй его; если bash доступен для вызова, вызови через него ровно `printf 'EXPLORE_BASH_MUST_NOT_RUN\n'` с workdir=TEST_DIR и ожидай package runtime rejection. Не используй локальный shell и не обходи rejection. Не вызывай Task. Верни own remote_status evidence, использованные tools, прочитанные exact values, Bash tool result и changes. PASS разрешён только если read-only checks успешны, а Bash отсутствует или фактически отклонён. Если marker реально выполнился, верни FAIL."

Root должен дождаться child.

Ожидается:
- child самостоятельно вызывает remote_status;
- read/glob/grep доступны согласно host policy;
- оба значения прочитаны правильно;
- package Bash для built-in explore отсутствует в catalog или точный вызов фактически отклонён;
- Task/grandchild отсутствует;
- изменений нет.

Prose-заявление child о доступности Bash без фактического tool result не является
доказательством ни PASS, ни FAIL. Если ST-11 не создал оба result-файла, read-only
часть ST-12 BLOCKED; Bash-boundary evidence всё равно зафиксируй отдельно. Если
explore фактически выполняет marker или mutation, ST-12 FAIL.

ST-13: BACKGROUND TASK GUARD

Проверь model-visible schema Task.

Ожидается:
- если параметр background отсутствует в schema, зафиксируй `schema-omitted` и ST-13 PASS без попытки изобрести или внедрить аргумент;
- если background доступен в schema, выполни один Task-вызов с subagent_type=general, background=true и без task_id; передай harmless инструкцию только вызвать remote_status и завершиться;
- при доступном аргументе ожидается package runtime rejection до успешного child result;
- доступность fresh foreground Task зафиксируй по ST-11 отдельно, но не делай её prerequisite schema-guard проверки;
- автоматического retry с изменёнными аргументами нет.

Schema omission или фактический runtime rejection является PASS. Если background
child реально запускается или возвращает успешный Task result, ST-13 FAIL.

ST-14: TASK RESUME POLICY

Определи из текущего generated system context, включён ли package Task resume.

Если Task resume disabled:

1. Не отправляй task_id и не пытайся обходить launch decision.
2. Проверь, что generated context однозначно сообщает disabled.
3. Проверь, что fresh foreground Task был доступен в ST-11.

Ожидается:
- task_id не отправлялся;
- resume decision записан как disabled;
- fresh foreground direct children работали.

При таком результате ST-14 PASS.

Если ST-11 не подтвердил fresh foreground Task, disabled-decision часть всё
равно зафиксируй, но итог ST-14 BLOCKED с prerequisite ST-11.

Если Task resume enabled:

1. Используй task_id успешно завершённого Child A из ST-11 и тот же subagent_type=general.
2. Вызови Task с этим точным task_id один раз.
3. Передай инструкцию:
   "Это resume self-test. Старый package preflight недействителен. Сначала заново вызови package remote_status. Затем только прочитай свой существующий result-a.txt. Ничего не изменяй. Верни preflight и read evidence."
4. По доступному Task result evidence проверь reuse существующего child ID.
5. Проверь новый собственный remote_status.
6. Проверь отсутствие mutation.

При успешном resume result, новом child remote_status и отсутствии mutation
ST-14 PASS по доступному agent evidence. Не утверждай, что это независимо
доказывает exact SDK session identity.

Не проверяй invented, foreign-root или cross-launch IDs в этой автономной
проверке. Если task_id недоступен из-за конкретного ST-11 FAIL/BLOCKED, ST-14
BLOCKED с prerequisite ST-11. Exact child-session identity без SDK evidence
всегда добавь в NOT_COVERED.

ST-15: FINAL VERIFY И CLEANUP

До cleanup root должен через package read и byte-exact package bash проверить:

- при MUTATION_BRANCH=`apply_patch` mutation.txt содержит exact bytes `after\n`, размер 6, hex `61667465720a`;
- при MUTATION_BRANCH=`write+edit` mutation.txt содержит exact bytes `after`, размер 5, hex `6166746572`;
- timeout-selftest.sh является ожидаемым regular file;
- child-a/result-a.txt содержит exact bytes `child-a`, размер 7, hex `6368696c642d61`;
- child-b/result-b.txt содержит exact bytes `child-b`, размер 7, hex `6368696c642d62`.

Через package bash проверь внутри TEST_DIR:
- список всех файлов;
- numeric modes;
- отсутствие `.opencode-lock-*`;
- отсутствие sibling temporary artifacts;
- отсутствие process с точным timeout script path, используя тот же safe
  `/proc` exact-token method из ST-09 без helpers, получающих SCRIPT argv;
- отсутствие symlink.

Зафиксируй evidence до удаления.

Затем перед cleanup:
1. Повторно проверь, что TEST_DIR canonical.
2. Проверь, что parent TEST_DIR точно равен WORKDIR.
3. Проверь prefix basename `.opencode-ssh-selftest-`.
4. Проверь, что TEST_DIR не symlink.

Только после этих проверок через package bash удали ровно TEST_DIR командой с безопасно quoted exact path.

Не используй wildcard и не удаляй parent.

После удаления через отдельный package bash проверь, что exact TEST_DIR больше не существует.

Ожидается:
- все применимые expected files корректны до cleanup;
- нет lock/temp/process/symlink artifacts;
- удалён только TEST_DIR;
- TEST_DIR отсутствует после cleanup;
- все наблюдавшиеся package mutation paths находились внутри TEST_DIR.

Cleanup обязан выполняться даже после FAIL/BLOCKED предыдущих строк, если exact
TEST_DIR безопасно подтверждён. Если обязательные files отсутствуют из-за
предыдущего FAIL, final content verification ST-15 BLOCKED, но отдельно сообщи
cleanup PASS/FAIL и не превращай BLOCKED в новый независимый filesystem defect.
Если cleanup не удалил exact TEST_DIR, оставил идентифицированный owned process
или сам нарушил scope, ST-15 всегда FAIL независимо от content status. Если
cleanup PASS, но content verification зависит от предыдущего FAIL, итоговый
статус ST-15 BLOCKED.

ИТОГОВЫЙ ОТЧЁТ

После завершения выведи Markdown-таблицу строго с колонками:

| ID | Проверка | Ожидалось | Наблюдалось | Evidence | Status |

Добавь строки ST-01...ST-15.

В Evidence указывай краткие фактические данные:
- tool name;
- exit code;
- bounded output;
- canonical path относительно WORKDIR;
- child preflight result;
- exact changed test paths;
- отсутствие retry.

Не включай credentials, raw connection secrets или unrelated project content.

После таблицы выведи:

TOTAL: PASS <количество>; FAIL <количество>; BLOCKED <количество>; TOTAL 15
OVERALL: PASS | FAIL

OVERALL=PASS разрешён только если:
- все ST-01...ST-15 имеют PASS;
- cleanup подтверждён;
- ни один child/process/tool call не остался unsettled;
- mutation не вышла за TEST_DIR;
- автоматических retry не было.

Если хотя бы один обязательный тест FAIL или BLOCKED, OVERALL=FAIL. Не включай
model-filtered NOT_APPLICABLE tools в FAIL/BLOCKED counts.

Затем выведи:

FAILURES:
- список failed ID с причиной;
- либо `none`.

BLOCKED:
- список blocked ID и точный prerequisite ID;
- либо `none`.

MUTATION CATALOG:
- model API ID, если доступен;
- фактически наблюдавшиеся write/edit/apply_patch;
- выбранный MUTATION_BRANCH;
- model-filtered tools со статусом NOT_APPLICABLE.

CHANGES:
- перечисли только временные test paths;
- подтверди, что TEST_DIR удалён;
- подтверди, что все наблюдавшиеся package mutation paths были внутри TEST_DIR;
- не заявляй project-wide отсутствие чужих или ненаблюдаемых изменений.

UNSETTLED:
- перечисли незавершённые child/process/tool calls;
- либо `none`.

NOT_COVERED:
- визуальное progressive обновление stdout/stderr в Bash card;
- визуальное сохранение output после failure/timeout;
- корректность attribution в permission dialog;
- выбор и process-wide поведение external_directory `Allow always`;
- ручной deny remote_status через permission UI;
- человеческое прерывание через Escape;
- фактическое временное overlap Task execution без barrier/SDK evidence;
- exact session identity enabled-resume без SDK evidence;
- независимое project-wide доказательство отсутствия изменений вне TEST_DIR;
- универсальное завершение произвольных remote descendants;
- поведение sudo;
- root-workspace `/`;
- real permission UI;
- default/direct-child TUI rendering.

FINAL SUMMARY:
Кратко опиши:
1. Подтверждён ли реальный SSH-backed root workflow.
2. Подтверждены ли independent child preflights.
3. Подтверждены ли disjoint child mutations.
4. Подтверждены ли file tools.
5. Подтверждены ли timeout/no-retry и cleanup.
6. Какие manual UI checks всё ещё обязательны.

Начни выполнение сейчас с ST-01. Не отвечай планом.
```
