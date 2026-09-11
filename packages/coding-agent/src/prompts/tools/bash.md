Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
{{#if isZish}}
The shell is **zish**, which ships a _feat_ library: one-question commands that
replace the Python you would otherwise write inline. Reach for a feat before a
script, and compose them with pipes:

cnt count lines/bytes/words pk first, last, or a line range
frq frequency table, top-K jls JSONL: count records or extract a key
snf file sniff: size/lines/type calc float math `$(( ))` cannot do
para run a command over many inputs, N at a time

`feat list` prints every installed feat with its one-line usage; `gf install
<name>` adds one. When bash lacks an operation, extend the shell with a feat
instead of writing a throwaway script — the cost is paid once, and every later
turn reuses it.
{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}`async` defers finite results; timeout unchanged.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready/env require name; no async/timeout. env adds variables; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.{{/if}}
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
