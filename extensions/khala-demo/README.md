# Khala demo extension

The `/khala-demo` command opens a packaged read-only Khala Archive with representative Work and Execution states.
It includes history by default so completed and stopped Work is visible immediately.

The demo database is separate from the live Archive.
The command does not submit Work, modify either database, start Pi sessions, or call models.
Because it is never copied into the live Archive, there are no demo entries to opt out of or clear.
Each invocation reopens the unchanged fixture after the previous view closes.
A concurrent invocation reports that the demo is already open.

The command requires a UI-capable Pi session for interactive browsing.
In print or other non-TUI modes it displays the fixture dashboard as a notification.
